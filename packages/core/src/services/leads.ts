import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { affiliates, commissions, conversions, leads, programs, type Lead, type Program } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { writeAudit } from "./audit";
import { recordConversion, approveConversion, cancelConversion, currentCommission, hashEmail, CONVERSION_SOURCES } from "./conversions";
import { approveCommission } from "./commissions";
import { httpUrl } from "../urls";
import { VISITOR_ID } from "./journeys";

/**
 * Leads intake (pay-per-lead programs). A lead is a conversion of kind `lead` with a contact
 * record beside it. It is attributed exactly like a sale (click token, coupon, or manual with a
 * reason), earns the program's fixed lead commission, and sits pending until the merchant
 * qualifies it (approve conversion + commission) or disqualifies it (cancel + void). Programs
 * can auto-qualify. A second lead with the same email for the same program inside the
 * dedupe window is recorded as a duplicate and earns nothing, so affiliates cannot be paid
 * twice for one person.
 *
 * Intake channels: the API (API keys with conversions.write), a manual form in the app, and
 * a public capture endpoint per program (`POST /capture/:token`) for forms on the merchant's
 * own site, which forwards the click token the redirect placed in the `ref` query parameter.
 */
export const LEAD_DISPOSITIONS = ["qualified", "disqualified", "duplicate"] as const;
export type LeadDisposition = (typeof LEAD_DISPOSITIONS)[number];

const contactShape = {
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(200).optional(),
  fields: z.record(z.string().max(60), z.string().max(2000)).default({}),
  landingUrl: httpUrl.optional(),
};

export const recordLeadSchema = z
  .object({
    source: z.enum(CONVERSION_SOURCES).default("api"),
    /** Id from the source system; leads with the same id are returned, not duplicated. */
    externalLeadId: z.string().min(1).max(200).optional(),
    programId: z.string().optional(),
    offerId: z.string().optional(),
    ...contactShape,
    clickToken: z.string().optional(),
    clickTokens: z.array(z.string()).optional(),
    couponCode: z.string().max(40).optional(),
    /** Visitor id from the site snippet, when the form carried it. */
    visitorId: z.string().regex(VISITOR_ID).optional(),
    occurredAt: z.coerce.date().optional(),
    /** Manual attribution: explicit affiliate + program with a reason. */
    affiliateId: z.string().optional(),
    reason: z.string().max(1000).optional(),
  })
  .refine((v) => v.email || v.phone || v.name, { message: "a lead needs at least a name, an email or a phone number" });
export type RecordLeadInput = z.input<typeof recordLeadSchema>;

export interface LeadResult {
  lead: Lead;
  duplicate: boolean;
  disposition: LeadDisposition | null;
  commissionMinor: number;
}

async function programFor(db: DbLike, ctx: TenantContext, programId: string): Promise<Program> {
  const program = await db.query.programs.findFirst({ where: and(eq(programs.id, programId), eq(programs.tenantId, ctx.tenantId)) });
  if (!program) throw notFound("program", programId);
  return program;
}

/** Same email, same program, inside the program's dedupe window: the earlier lead wins. */
async function findDuplicate(db: DbLike, ctx: TenantContext, programId: string | null, email: string | null, at: Date, days: number): Promise<Lead | null> {
  if (!email || !programId) return null;
  const since = new Date(at.getTime() - days * 86_400_000);
  const row = await db.query.leads.findFirst({
    where: and(eq(leads.tenantId, ctx.tenantId), eq(leads.programId, programId), eq(leads.email, email.toLowerCase()), gte(leads.createdAt, since), sql`${leads.disposition} is distinct from 'duplicate'`),
    orderBy: [desc(leads.createdAt)],
  });
  return row ?? null;
}

export async function recordLead(db: DbLike, ctx: TenantContext, rawInput: RecordLeadInput): Promise<LeadResult> {
  requirePerm(ctx, "conversions.write");
  const input = recordLeadSchema.parse(rawInput);
  const email = input.email?.toLowerCase() ?? null;
  const externalId = input.externalLeadId ?? `lead:${newId("lead")}`;
  const occurredAt = input.occurredAt ?? ctx.now();

  return withTx(db, async (tx) => {
    // Idempotent on the source id, like sales.
    if (input.externalLeadId) {
      const existing = await tx.select({ lead: leads }).from(leads).innerJoin(conversions, eq(conversions.id, leads.conversionId)).where(and(eq(conversions.tenantId, ctx.tenantId), eq(conversions.kind, "lead"), eq(conversions.source, input.source), eq(conversions.externalOrderId, externalId))).limit(1);
      if (existing[0]) return { lead: existing[0].lead, duplicate: true, disposition: existing[0].lead.disposition as LeadDisposition | null, commissionMinor: 0 };
    }

    const result = await recordConversion(tx, ctx, {
      kind: "lead",
      source: input.source,
      externalOrderId: externalId,
      offerId: input.offerId,
      programId: input.programId,
      amountMinor: 0,
      customerRef: email ?? input.phone ?? input.name,
      customerEmail: input.email,
      clickToken: input.clickToken,
      clickTokens: input.clickTokens,
      couponCode: input.couponCode,
      visitorId: input.visitorId,
      occurredAt,
      affiliateId: input.affiliateId,
      reason: input.reason,
      metadata: {},
    });
    const conversion = result.conversion;
    const programId = conversion.programId ?? input.programId ?? null;
    const program = programId ? await programFor(tx, ctx, programId) : null;
    const dup = program ? await findDuplicate(tx, ctx, program.id, email, occurredAt, program.leadDedupeDays) : null;

    const [lead] = await tx
      .insert(leads)
      .values({
        id: newId("lead"),
        tenantId: ctx.tenantId,
        conversionId: conversion.id,
        programId,
        affiliateId: conversion.affiliateId,
        name: input.name ?? null,
        email,
        phone: input.phone ?? null,
        company: input.company ?? null,
        fields: input.fields,
        landingUrl: input.landingUrl ?? null,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      })
      .returning();

    let disposition: LeadDisposition | null = null;
    if (dup) {
      // Duplicate: the sale record is cancelled (voiding any commission) and the lead marked.
      await cancelConversion(tx, ctx, conversion.id, `duplicate of lead ${dup.id}`);
      disposition = "duplicate";
      await tx.update(leads).set({ disposition, dispositionNote: `Duplicate of ${dup.id}`, disposedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(leads.id, lead!.id));
    } else if (program?.leadApproval === "auto" && conversion.affiliateId) {
      await qualifyRow(tx, ctx, lead!, "auto-qualified by program settings");
      disposition = "qualified";
    }
    const commission = await currentCommission(tx, conversion.id);
    await writeAudit(tx, ctx, { entityType: "lead", entityId: lead!.id, action: "created", after: { conversionId: conversion.id, programId, affiliateId: conversion.affiliateId, disposition, email: email ? "[recorded]" : null } });
    const fresh = (await tx.query.leads.findFirst({ where: eq(leads.id, lead!.id) }))!;
    return { lead: fresh, duplicate: false, disposition, commissionMinor: commission && commission.status !== "void" && commission.status !== "reversed" ? commission.amountMinor : 0 };
  });
}

async function qualifyRow(db: DbLike, ctx: TenantContext, lead: Lead, note: string | undefined): Promise<Lead> {
  const conversion = await db.query.conversions.findFirst({ where: eq(conversions.id, lead.conversionId) });
  if (!conversion) throw notFound("conversion", lead.conversionId);
  if (conversion.status === "pending") await approveConversion(db, ctx, conversion.id);
  const commission = await currentCommission(db, conversion.id);
  if (commission && commission.status === "pending") await approveCommission(db, ctx, commission.id, note ?? "lead qualified");
  const [after] = await db.update(leads).set({ disposition: "qualified", dispositionNote: note ?? null, disposedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(leads.id, lead.id)).returning();
  return after!;
}

export const dispositionSchema = z.object({ note: z.string().max(1000).optional() });

/** The merchant confirms the lead is real: the commission is approved and settles after the holding period. */
export async function qualifyLead(db: DbLike, ctx: TenantContext, leadId: string, rawInput: z.input<typeof dispositionSchema> = {}): Promise<Lead> {
  requirePerm(ctx, "conversions.write");
  const { note } = dispositionSchema.parse(rawInput);
  return withTx(db, async (tx) => {
    const lead = await getLead(tx, ctx, leadId);
    if (lead.disposition === "qualified") return lead;
    if (lead.disposition) throw validation(`lead is already ${lead.disposition}`);
    const after = await qualifyRow(tx, ctx, lead, note);
    await writeAudit(tx, ctx, { entityType: "lead", entityId: leadId, action: "qualified", reason: note });
    return after;
  });
}

/** Not a real lead (spam, wrong number, existing customer): the conversion is cancelled and the commission voided. */
export async function disqualifyLead(db: DbLike, ctx: TenantContext, leadId: string, rawInput: z.input<typeof dispositionSchema> & { note: string }): Promise<Lead> {
  requirePerm(ctx, "conversions.write");
  const { note } = dispositionSchema.parse(rawInput);
  if (!note?.trim()) throw validation("a reason is required to disqualify a lead");
  return withTx(db, async (tx) => {
    const lead = await getLead(tx, ctx, leadId);
    if (lead.disposition === "disqualified") return lead;
    if (lead.disposition === "duplicate") throw validation("lead is a duplicate");
    const conversion = await tx.query.conversions.findFirst({ where: eq(conversions.id, lead.conversionId) });
    if (conversion && !["cancelled", "reversed"].includes(conversion.status)) {
      if (conversion.status === "approved") {
        // approved leads are reversed rather than cancelled (the state machine has no approved → cancelled)
        const commission = await currentCommission(tx, conversion.id);
        if (commission && ["pending", "approved", "payable"].includes(commission.status)) {
          const { reverseCommissionRow } = await import("./commissions");
          await reverseCommissionRow(tx, ctx, commission, `lead disqualified: ${note}`);
        }
        await tx.update(conversions).set({ status: "reversed", updatedAt: ctx.now() }).where(eq(conversions.id, conversion.id));
      } else await cancelConversion(tx, ctx, conversion.id, `lead disqualified: ${note}`);
    }
    const [after] = await tx.update(leads).set({ disposition: "disqualified", dispositionNote: note, disposedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(leads.id, leadId)).returning();
    await writeAudit(tx, ctx, { entityType: "lead", entityId: leadId, action: "disqualified", reason: note });
    return after!;
  });
}

export async function getLead(db: DbLike, ctx: TenantContext, leadId: string): Promise<Lead> {
  requirePerm(ctx, "read");
  const row = await db.query.leads.findFirst({ where: and(eq(leads.id, leadId), eq(leads.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("lead", leadId);
  return row;
}

export interface LeadRow {
  lead: Lead;
  conversionStatus: string;
  affiliateName: string | null;
  programName: string | null;
  commissionMinor: number | null;
  commissionStatus: string | null;
  currency: string;
}

export async function listLeads(db: DbLike, ctx: TenantContext, filter: { programId?: string; affiliateId?: string; disposition?: LeadDisposition | "pending"; limit?: number } = {}): Promise<LeadRow[]> {
  requirePerm(ctx, "read");
  const rows = await db
    .select({ lead: leads, conversionStatus: conversions.status, currency: conversions.currency, affiliateName: affiliates.name, programName: programs.name })
    .from(leads)
    .innerJoin(conversions, eq(conversions.id, leads.conversionId))
    .leftJoin(affiliates, eq(affiliates.id, leads.affiliateId))
    .leftJoin(programs, eq(programs.id, leads.programId))
    .where(
      and(
        eq(leads.tenantId, ctx.tenantId),
        filter.programId ? eq(leads.programId, filter.programId) : undefined,
        filter.affiliateId ? eq(leads.affiliateId, filter.affiliateId) : undefined,
        filter.disposition === "pending" ? isNull(leads.disposition) : filter.disposition ? eq(leads.disposition, filter.disposition) : undefined,
      ),
    )
    .orderBy(desc(leads.createdAt))
    .limit(filter.limit ?? 200);
  return attachCommissions(db, ctx, rows);
}

async function attachCommissions(db: DbLike, ctx: TenantContext, rows: Omit<LeadRow, "commissionMinor" | "commissionStatus">[]): Promise<LeadRow[]> {
  const ids = rows.map((r) => r.lead.conversionId);
  const coms = ids.length ? await db.select().from(commissions).where(and(eq(commissions.tenantId, ctx.tenantId), inArray(commissions.conversionId, ids), sql`${commissions.status} <> 'void'`)).orderBy(desc(commissions.createdAt)) : [];
  const byConversion = new Map<string, (typeof coms)[number]>();
  for (const c of coms) if (!byConversion.has(c.conversionId)) byConversion.set(c.conversionId, c);
  return rows.map((r) => {
    const c = byConversion.get(r.lead.conversionId);
    return { ...r, commissionMinor: c?.amountMinor ?? null, commissionStatus: c?.status ?? null };
  });
}

/** Portal: an affiliate's own leads without the contact details (customer data stays with the merchant). */
export async function listLeadsForAffiliate(db: DbLike, ctx: TenantContext, affiliateId: string, limit = 200) {
  requireAffiliate(ctx, affiliateId);
  const rows = await listLeads(db, { ...ctx, actor: { type: "system", role: "owner" } }, { affiliateId, limit });
  return rows.map((r) => ({
    id: r.lead.id,
    programId: r.lead.programId,
    programName: r.programName,
    createdAt: r.lead.createdAt,
    disposition: r.lead.disposition,
    status: r.lead.disposition ?? "pending",
    conversionStatus: r.conversionStatus,
    commissionMinor: r.commissionMinor,
    commissionStatus: r.commissionStatus,
    currency: r.currency,
    /** A hint the affiliate can recognise without exposing the contact: the email's domain. */
    emailDomain: r.lead.email && !r.lead.erasedAt ? r.lead.email.split("@")[1] ?? null : null,
  }));
}

/** Counts for the merchant home and the leads page header. */
export async function leadSummary(db: DbLike, ctx: TenantContext): Promise<{ pending: number; qualified: number; disqualified: number; duplicate: number }> {
  requirePerm(ctx, "read");
  const rows = await db.select({ disposition: leads.disposition, n: sql<number>`count(*)`.mapWith(Number) }).from(leads).where(eq(leads.tenantId, ctx.tenantId)).groupBy(leads.disposition);
  const out = { pending: 0, qualified: 0, disqualified: 0, duplicate: 0 };
  for (const r of rows) out[(r.disposition ?? "pending") as keyof typeof out] = r.n;
  return out;
}

/** Retention: blank contact details of settled leads older than the cutoff (the conversion row stays). */
export async function eraseOldLeadContacts(db: DbLike, tenantId: string, before: Date): Promise<number> {
  const rows = await db
    .update(leads)
    .set({ name: null, email: null, phone: null, company: null, fields: {}, landingUrl: null, erasedAt: sql`now()` })
    .where(and(eq(leads.tenantId, tenantId), isNull(leads.erasedAt), lt(leads.createdAt, before), sql`${leads.disposition} is not null`))
    .returning({ id: leads.id });
  return rows.length;
}

export async function countOldLeadContacts(db: DbLike, tenantId: string, before: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(leads).where(and(eq(leads.tenantId, tenantId), isNull(leads.erasedAt), lt(leads.createdAt, before), sql`${leads.disposition} is not null`));
  return row?.n ?? 0;
}

/** Public capture form: the program is found by its capture token (RLS bypass, like join tokens). */
export const captureSchema = z.object({
  ...contactShape,
  /** Click token forwarded from the redirect's `ref` query parameter. */
  ref: z.string().max(200).optional(),
  /** Visitor id the site snippet fills into a hidden `referly_visitor` field. */
  visitorId: z.string().regex(VISITOR_ID).optional(),
  couponCode: z.string().max(40).optional(),
  /** Where to send the browser afterwards (plain HTML forms); must be http(s). */
  redirect: httpUrl.optional(),
});

export async function getProgramByCaptureToken(db: DbLike, token: string): Promise<Program | null> {
  return (await db.query.programs.findFirst({ where: eq(programs.leadCaptureToken, token) })) ?? null;
}

export { hashEmail };
