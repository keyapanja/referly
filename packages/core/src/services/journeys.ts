import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { affiliates, clicks, journeyEvents, programs, tenants, type Conversion, type JourneyEvent, type Tenant, type TenantTracking } from "../db/schema";
import { newId, newToken } from "../ids";
import { validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit } from "./audit";
import { getTenant } from "./tenants";

/**
 * Website tracking (TRK-09): a first-party snippet on the merchant's own site records the
 * affiliate journey without any checkout work. The snippet keeps the click token the tracking
 * redirect placed in `?ref=`, assigns the visitor a first-party id, and reports page views,
 * custom events and (optionally) orders to public endpoints keyed by the workspace's site key.
 *
 * Everything the browser sends is untrusted: the tenant comes from the site key, the affiliate
 * only ever from a click token that resolves inside that tenant, origins are checked against
 * the workspace's domain list, and snippet-reported sales are off unless the merchant turns
 * them on for a fixed set of domains. Journey rows are analytics, never money: a sale is still
 * attributed by the same engine as every other source.
 */
export const JOURNEY_EVENT_TYPES = ["page_view", "event", "conversion", "lead"] as const;
export type JourneyEventType = (typeof JOURNEY_EVENT_TYPES)[number];

/** Snippet-generated ids: short, URL-safe, no lookalikes needed. */
export const VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_EVENTS_PER_BATCH = 50;
const MAX_PROPERTIES_BYTES = 2048;
/** How far back a visitor's earlier click is used when a batch arrives without a ref. */
const VISITOR_MEMORY_DAYS = 400;
/** Sessions the listing goes back through. */
const MAX_SESSION_ROWS = 500;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TrackingView {
  enabled: boolean;
  siteKey: string | null;
  domains: string[];
  pixelConversions: boolean;
  consentMode: "off" | "wait";
  lastEventAt: Date | null;
  lastEventHost: string | null;
  events7d: number;
  visitors7d: number;
}

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$|^localhost$/, "enter a hostname such as shop.example.com")
  .transform((h) => h.replace(/^www\./, ""));

export const trackingSettingsSchema = z
  .object({
    domains: z.array(hostname).max(20).optional(),
    pixelConversions: z.boolean().optional(),
    consentMode: z.enum(["off", "wait"]).optional(),
  })
  .strict();

export async function getTracking(db: DbLike, ctx: TenantContext): Promise<TrackingView> {
  requirePerm(ctx, "read");
  const tenant = await getTenant(db, ctx);
  const since = new Date(ctx.now().getTime() - 7 * 86_400_000);
  const [stats] = await db
    .select({
      events: sql<number>`count(*)`.mapWith(Number),
      visitors: sql<number>`count(distinct ${journeyEvents.visitorId})`.mapWith(Number),
    })
    .from(journeyEvents)
    .where(and(eq(journeyEvents.tenantId, ctx.tenantId), gte(journeyEvents.occurredAt, since)));
  const [last] = await db
    .select({ occurredAt: journeyEvents.occurredAt, url: journeyEvents.url })
    .from(journeyEvents)
    .where(and(eq(journeyEvents.tenantId, ctx.tenantId), inArray(journeyEvents.type, ["page_view", "event"])))
    .orderBy(desc(journeyEvents.occurredAt), desc(journeyEvents.seq))
    .limit(1);
  return {
    enabled: !!tenant.siteKey,
    siteKey: tenant.siteKey,
    domains: tenant.tracking?.domains ?? [],
    pixelConversions: !!tenant.tracking?.pixelConversions,
    consentMode: tenant.tracking?.consentMode ?? "off",
    lastEventAt: last?.occurredAt ?? null,
    lastEventHost: last?.url ? hostOf(last.url) : null,
    events7d: stats?.events ?? 0,
    visitors7d: stats?.visitors ?? 0,
  };
}

/** Mint the site key. Idempotent: an enabled workspace keeps its key. */
export async function enableTracking(db: DbLike, ctx: TenantContext): Promise<string> {
  requirePerm(ctx, "integrations.manage");
  const tenant = await getTenant(db, ctx);
  if (tenant.siteKey) return tenant.siteKey;
  const siteKey = `site_${newToken(24)}`;
  await db.update(tenants).set({ siteKey, updatedAt: ctx.now() }).where(eq(tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, { entityType: "tenant", entityId: ctx.tenantId, action: "tracking_enabled", after: { siteKey } });
  return siteKey;
}

/** Replace the site key. Snippets carrying the old key stop being accepted at once. */
export async function rotateSiteKey(db: DbLike, ctx: TenantContext): Promise<string> {
  requirePerm(ctx, "integrations.manage");
  const tenant = await getTenant(db, ctx);
  if (!tenant.siteKey) return enableTracking(db, ctx);
  const siteKey = `site_${newToken(24)}`;
  await db.update(tenants).set({ siteKey, updatedAt: ctx.now() }).where(eq(tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, { entityType: "tenant", entityId: ctx.tenantId, action: "tracking_key_rotated", before: { siteKey: tenant.siteKey }, after: { siteKey } });
  return siteKey;
}

export async function updateTracking(db: DbLike, ctx: TenantContext, rawInput: z.input<typeof trackingSettingsSchema>): Promise<TenantTracking> {
  requirePerm(ctx, "integrations.manage");
  const input = trackingSettingsSchema.parse(rawInput);
  const tenant = await getTenant(db, ctx);
  const next: TenantTracking = { ...(tenant.tracking ?? {}) };
  if (input.domains !== undefined) next.domains = [...new Set(input.domains)];
  if (input.pixelConversions !== undefined) next.pixelConversions = input.pixelConversions;
  if (input.consentMode !== undefined) next.consentMode = input.consentMode;
  if (next.pixelConversions && !(next.domains?.length)) throw validation("list your website's domains before accepting orders reported by the snippet");
  await db.update(tenants).set({ tracking: next, updatedAt: ctx.now() }).where(eq(tenants.id, ctx.tenantId));
  await writeAudit(db, ctx, { entityType: "tenant", entityId: ctx.tenantId, action: "tracking_updated", before: { tracking: tenant.tracking ?? {} }, after: { tracking: next } });
  return next;
}

/** Public lookup for the snippet endpoints; runs before the request is scoped, so it needs RLS bypass. */
export async function getTenantBySiteKey(db: DbLike, siteKey: string): Promise<Tenant | null> {
  if (!/^site_[A-Za-z0-9]{24}$/.test(siteKey)) return null;
  return (await db.query.tenants.findFirst({ where: eq(tenants.siteKey, siteKey) })) ?? null;
}

/**
 * Is a request from this browser origin allowed to report? With no domains configured any
 * origin may (the snippet works the moment it is pasted); with domains, the origin's host must
 * be one of them or a subdomain of one. Requests without an Origin header (not browsers) are
 * refused once domains are set.
 */
export function originAllowed(tracking: TenantTracking | null | undefined, origin: string | null | undefined): boolean {
  const domains = tracking?.domains ?? [];
  if (domains.length === 0) return true;
  const host = origin ? hostOf(origin) : null;
  if (!host) return false;
  return domains.some((d) => host === d || host === `www.${d}` || host.endsWith(`.${d}`));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function pathOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.slice(0, 500);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const clientEvent = z.object({
  type: z.enum(["page_view", "event"]),
  name: z.string().trim().min(1).max(80).optional(),
  url: z.string().max(2000).optional(),
  title: z.string().max(300).optional(),
  referrer: z.string().max(2000).optional(),
  properties: z.record(z.string().max(60), z.unknown()).optional(),
  /** Client clock, epoch milliseconds. Used only when it is plausible. */
  at: z.number().optional(),
});

export const ingestSchema = z.object({
  visitorId: z.string().regex(VISITOR_ID),
  sessionId: z.string().regex(VISITOR_ID),
  /** Click token from the landing URL or the snippet's first-party cookie. */
  ref: z.string().max(64).nullable().optional(),
  /** `granted` when the snippet runs in consent mode and the visitor agreed; `not_required` otherwise. */
  consent: z.enum(["granted", "not_required"]).optional(),
  events: z.array(clientEvent).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type IngestInput = z.input<typeof ingestSchema>;

export interface IngestResult {
  accepted: number;
  attributed: boolean;
  /** When the ref resolved: how long the snippet should keep it, from the program's attribution window. */
  ref: { ttlSeconds: number } | null;
  /** Set when the batch was refused: the workspace requires consent and the batch did not carry it. */
  dropped?: "consent_required" | "no_affiliate";
}

export interface IngestOptions {
  /** The workspace's consent mode is `wait`: batches without `consent: "granted"` are dropped, whatever the page sent. */
  consentRequired?: boolean;
}

interface ResolvedClick {
  clickId: string;
  affiliateId: string;
  programId: string;
  ttlSeconds: number | null;
}

async function resolveClick(db: DbLike, ctx: TenantContext, ref: string | null | undefined, visitorId: string): Promise<ResolvedClick | null> {
  if (ref) {
    const click = await db.query.clicks.findFirst({ where: and(eq(clicks.tenantId, ctx.tenantId), eq(clicks.clickToken, ref)) });
    if (click) {
      const program = await db.query.programs.findFirst({ where: eq(programs.id, click.programId) });
      return { clickId: click.id, affiliateId: click.affiliateId, programId: click.programId, ttlSeconds: program ? program.attributionWindowDays * 86_400 : null };
    }
  }
  // No usable ref (cookie cleared, another device profile): stay with the click this visitor arrived through earlier.
  const since = new Date(ctx.now().getTime() - VISITOR_MEMORY_DAYS * 86_400_000);
  const [prior] = await db
    .select({ clickId: journeyEvents.clickId, affiliateId: journeyEvents.affiliateId, programId: journeyEvents.programId })
    .from(journeyEvents)
    .where(and(eq(journeyEvents.tenantId, ctx.tenantId), eq(journeyEvents.visitorId, visitorId), isNotNull(journeyEvents.clickId), gte(journeyEvents.occurredAt, since)))
    .orderBy(desc(journeyEvents.occurredAt), desc(journeyEvents.seq))
    .limit(1);
  if (prior?.clickId && prior.affiliateId && prior.programId) return { clickId: prior.clickId, affiliateId: prior.affiliateId, programId: prior.programId, ttlSeconds: null };
  return null;
}

function boundedProperties(props: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v.slice(0, 500);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = JSON.stringify(v).slice(0, 500);
  }
  return JSON.stringify(out).length > MAX_PROPERTIES_BYTES ? { _truncated: true } : out;
}

/** Client timestamps are trusted only inside the last day and not in the future. */
function plausibleTime(at: number | undefined, now: Date): Date {
  if (typeof at !== "number" || !Number.isFinite(at)) return now;
  const d = new Date(at);
  if (d.getTime() > now.getTime() + 60_000 || d.getTime() < now.getTime() - 86_400_000) return now;
  return d;
}

/** Record a batch the snippet sent. The request must already be scoped to the tenant the site key resolved to. */
export async function ingestEvents(db: DbLike, ctx: TenantContext, rawInput: IngestInput, opts: IngestOptions = {}): Promise<IngestResult> {
  const input = ingestSchema.parse(rawInput);
  if (opts.consentRequired && input.consent !== "granted") return { accepted: 0, attributed: false, ref: null, dropped: "consent_required" };
  const now = ctx.now();
  const click = await resolveClick(db, ctx, input.ref, input.visitorId);
  // Only visitors an affiliate sent are recorded; anyone else is not Referly's business.
  if (!click) return { accepted: 0, attributed: false, ref: null, dropped: "no_affiliate" };
  const rows = input.events.map((e) => ({
    id: newId("journeyEvent"),
    tenantId: ctx.tenantId,
    visitorId: input.visitorId,
    sessionId: input.sessionId,
    clickId: click?.clickId ?? null,
    affiliateId: click?.affiliateId ?? null,
    programId: click?.programId ?? null,
    type: e.type,
    name: e.type === "event" ? (e.name ?? "event") : (e.name ?? null),
    url: e.url?.slice(0, 2000) ?? null,
    path: pathOf(e.url),
    title: e.title?.slice(0, 300) ?? null,
    referrer: e.referrer?.slice(0, 2000) ?? null,
    conversionId: null,
    properties: boundedProperties(e.properties),
    consentState: input.consent ?? "not_required",
    occurredAt: plausibleTime(e.at, now),
    createdAt: now,
  }));
  await db.insert(journeyEvents).values(rows);
  return { accepted: rows.length, attributed: !!click, ref: click?.ttlSeconds ? { ttlSeconds: click.ttlSeconds } : null };
}

/** Click tokens this visitor arrived through, oldest first, for the attribution engine. */
export async function visitorClickTokens(db: DbLike, ctx: TenantContext, visitorId: string): Promise<string[]> {
  const rows = await db
    .select({ token: clicks.clickToken, at: sql<Date>`max(${journeyEvents.occurredAt})`.mapWith(journeyEvents.occurredAt) })
    .from(journeyEvents)
    .innerJoin(clicks, eq(clicks.id, journeyEvents.clickId))
    .where(and(eq(journeyEvents.tenantId, ctx.tenantId), eq(journeyEvents.visitorId, visitorId)))
    .groupBy(clicks.clickToken)
    .orderBy(asc(sql`max(${journeyEvents.occurredAt})`))
    .limit(10);
  return rows.map((r) => r.token);
}

/**
 * Put a recorded conversion on the visitor's journey. Called by the conversion service for every
 * source; it finds the visitor through the id the caller passed or through the attributed click
 * (a checkout that forwarded `ref` still lands on the journey). No visitor, no row.
 */
export async function linkConversion(db: DbLike, ctx: TenantContext, input: { conversion: Conversion; visitorId?: string | null; clickId?: string | null }): Promise<JourneyEvent | null> {
  if (!input.conversion.affiliateId) return null;
  let visitorId = input.visitorId ?? null;
  let sessionId: string | null = null;
  let consentState = "not_required";
  const where = visitorId
    ? and(eq(journeyEvents.tenantId, ctx.tenantId), eq(journeyEvents.visitorId, visitorId))
    : input.clickId
      ? and(eq(journeyEvents.tenantId, ctx.tenantId), eq(journeyEvents.clickId, input.clickId))
      : null;
  if (where) {
    const [latest] = await db.select({ visitorId: journeyEvents.visitorId, sessionId: journeyEvents.sessionId, consentState: journeyEvents.consentState }).from(journeyEvents).where(where).orderBy(desc(journeyEvents.occurredAt), desc(journeyEvents.seq)).limit(1);
    if (latest) {
      visitorId = latest.visitorId;
      sessionId = latest.sessionId;
      consentState = latest.consentState;
    }
  }
  if (!visitorId) return null;
  const c = input.conversion;
  const [row] = await db
    .insert(journeyEvents)
    .values({
      id: newId("journeyEvent"),
      tenantId: ctx.tenantId,
      visitorId,
      sessionId: sessionId ?? "server",
      clickId: input.clickId ?? null,
      affiliateId: c.affiliateId,
      programId: c.programId,
      type: c.kind === "lead" ? "lead" : "conversion",
      name: c.externalOrderId,
      url: typeof c.metadata?.url === "string" ? c.metadata.url.slice(0, 2000) : null,
      path: typeof c.metadata?.url === "string" ? pathOf(c.metadata.url) : null,
      title: null,
      referrer: null,
      conversionId: c.id,
      properties: { amountMinor: c.amountMinor, currency: c.currency, source: c.source, attributed: !!c.affiliateId },
      consentState,
      occurredAt: c.occurredAt,
      createdAt: ctx.now(),
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface JourneySession {
  visitorId: string;
  sessionId: string;
  affiliateId: string | null;
  affiliateName: string | null;
  programId: string | null;
  startedAt: Date;
  lastAt: Date;
  pages: number;
  events: number;
  conversions: number;
  leads: number;
  landingPath: string | null;
  landingUrl: string | null;
  referrer: string | null;
  /** Total of the sales on this visit, in minor units, and their currency. */
  saleMinor: number;
  currency: string | null;
  /** browsing | engaged (custom events) | lead | converted */
  outcome: "browsing" | "engaged" | "lead" | "converted";
}

export interface JourneySummary {
  /** Visits from affiliate links. */
  visits: number;
  /** Visits that ended in a purchase. */
  sales: number;
  /** Visits that ended in a sign-up but no purchase. */
  leads: number;
}

export interface SessionFilter {
  /** Look-back in days; default 30. */
  days?: number;
  affiliateId?: string;
  /** Only sessions with a sale or lead on them. */
  converted?: boolean;
  limit?: number;
}

function sessionGrouping(db: DbLike, tenantId: string, since: Date) {
  return db
    .select({
      visitorId: journeyEvents.visitorId,
      sessionId: journeyEvents.sessionId,
      affiliateId: sql<string | null>`max(${journeyEvents.affiliateId})`.as("affiliate_id"),
      programId: sql<string | null>`max(${journeyEvents.programId})`.as("program_id"),
      startedAt: sql<Date>`min(${journeyEvents.occurredAt})`.mapWith(journeyEvents.occurredAt).as("started_at"),
      lastAt: sql<Date>`max(${journeyEvents.occurredAt})`.mapWith(journeyEvents.occurredAt).as("last_at"),
      pages: sql<number>`count(*) filter (where ${journeyEvents.type} = 'page_view')`.mapWith(Number).as("pages"),
      events: sql<number>`count(*) filter (where ${journeyEvents.type} = 'event')`.mapWith(Number).as("events"),
      conversions: sql<number>`count(*) filter (where ${journeyEvents.type} = 'conversion')`.mapWith(Number).as("conversions"),
      leads: sql<number>`count(*) filter (where ${journeyEvents.type} = 'lead')`.mapWith(Number).as("leads"),
      landingPath: sql<string | null>`(array_agg(${journeyEvents.path} order by ${journeyEvents.occurredAt}, ${journeyEvents.seq}))[1]`.as("landing_path"),
      landingUrl: sql<string | null>`(array_agg(${journeyEvents.url} order by ${journeyEvents.occurredAt}, ${journeyEvents.seq}))[1]`.as("landing_url"),
      referrer: sql<string | null>`(array_agg(${journeyEvents.referrer} order by ${journeyEvents.occurredAt}, ${journeyEvents.seq}))[1]`.as("referrer"),
      saleMinor: sql<number>`coalesce(sum((${journeyEvents.properties}->>'amountMinor')::bigint) filter (where ${journeyEvents.type} = 'conversion'), 0)`.mapWith(Number).as("sale_minor"),
      currency: sql<string | null>`max(${journeyEvents.properties}->>'currency') filter (where ${journeyEvents.type} = 'conversion')`.as("currency"),
    })
    .from(journeyEvents)
    .where(and(eq(journeyEvents.tenantId, tenantId), gte(journeyEvents.occurredAt, since)))
    .groupBy(journeyEvents.visitorId, journeyEvents.sessionId)
    .as("s");
}

function outcomeOf(s: { conversions: number; leads: number; events: number }): JourneySession["outcome"] {
  if (s.conversions > 0) return "converted";
  if (s.leads > 0) return "lead";
  if (s.events > 0) return "engaged";
  return "browsing";
}

export async function listSessions(db: DbLike, ctx: TenantContext, filter: SessionFilter = {}): Promise<JourneySession[]> {
  requirePerm(ctx, "read");
  const days = Math.min(Math.max(filter.days ?? 30, 1), 400);
  const since = new Date(ctx.now().getTime() - days * 86_400_000);
  const s = sessionGrouping(db, ctx.tenantId, since);
  const conditions = [
    filter.affiliateId ? eq(s.affiliateId, filter.affiliateId) : undefined,
    isNotNull(s.affiliateId),
    filter.converted ? sql`${s.conversions} + ${s.leads} > 0` : undefined,
  ];
  const rows = await db
    .select()
    .from(s)
    .where(and(...conditions))
    .orderBy(desc(s.lastAt))
    .limit(Math.min(filter.limit ?? 100, MAX_SESSION_ROWS));
  const affiliateIds = [...new Set(rows.map((r) => r.affiliateId).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (affiliateIds.length) for (const a of await db.select({ id: affiliates.id, name: affiliates.name }).from(affiliates).where(and(eq(affiliates.tenantId, ctx.tenantId), inArray(affiliates.id, affiliateIds)))) names.set(a.id, a.name);
  return rows.map((r) => ({ ...r, affiliateName: r.affiliateId ? (names.get(r.affiliateId) ?? null) : null, outcome: outcomeOf(r) }));
}

export async function journeySummary(db: DbLike, ctx: TenantContext, days = 30): Promise<JourneySummary> {
  requirePerm(ctx, "read");
  const since = new Date(ctx.now().getTime() - Math.min(Math.max(days, 1), 400) * 86_400_000);
  const s = sessionGrouping(db, ctx.tenantId, since);
  const [row] = await db
    .select({
      visits: sql<number>`count(*)`.mapWith(Number),
      sales: sql<number>`count(*) filter (where ${s.conversions} > 0)`.mapWith(Number),
      leads: sql<number>`count(*) filter (where ${s.leads} > 0 and ${s.conversions} = 0)`.mapWith(Number),
    })
    .from(s)
    .where(isNotNull(s.affiliateId));
  return row ?? { visits: 0, sales: 0, leads: 0 };
}

/** Every event of one session, in order. */
export async function sessionEvents(db: DbLike, ctx: TenantContext, visitorId: string, sessionId: string): Promise<JourneyEvent[]> {
  requirePerm(ctx, "read");
  return db
    .select()
    .from(journeyEvents)
    .where(and(eq(journeyEvents.tenantId, ctx.tenantId), eq(journeyEvents.visitorId, visitorId), eq(journeyEvents.sessionId, sessionId)))
    .orderBy(asc(journeyEvents.occurredAt), asc(journeyEvents.seq))
    .limit(500);
}

/** Every event of one visitor across sessions, in order. */
export async function visitorEvents(db: DbLike, ctx: TenantContext, visitorId: string): Promise<JourneyEvent[]> {
  requirePerm(ctx, "read");
  return db
    .select()
    .from(journeyEvents)
    .where(and(eq(journeyEvents.tenantId, ctx.tenantId), eq(journeyEvents.visitorId, visitorId)))
    .orderBy(asc(journeyEvents.occurredAt), asc(journeyEvents.seq))
    .limit(500);
}

/**
 * The whole journey behind a conversion: found through the conversion's own journey row, or
 * failing that through the click it was attributed to. Empty when the site has no snippet.
 */
export async function journeyForConversion(db: DbLike, ctx: TenantContext, conversionId: string, clickId: string | null): Promise<{ visitorId: string | null; events: JourneyEvent[] }> {
  requirePerm(ctx, "read");
  const [own] = await db.select({ visitorId: journeyEvents.visitorId }).from(journeyEvents).where(and(eq(journeyEvents.tenantId, ctx.tenantId), eq(journeyEvents.conversionId, conversionId))).limit(1);
  let visitorId = own?.visitorId ?? null;
  if (!visitorId && clickId) {
    const [viaClick] = await db.select({ visitorId: journeyEvents.visitorId }).from(journeyEvents).where(and(eq(journeyEvents.tenantId, ctx.tenantId), eq(journeyEvents.clickId, clickId))).orderBy(desc(journeyEvents.occurredAt), desc(journeyEvents.seq)).limit(1);
    visitorId = viaClick?.visitorId ?? null;
  }
  if (!visitorId) return { visitorId: null, events: [] };
  return { visitorId, events: await visitorEvents(db, ctx, visitorId) };
}
