import { and, desc, eq, gte, inArray, isNotNull, isNull, like, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { clicks, conversions, journeyStats, programs, tenants, type Tenant, type TenantTracking } from "../db/schema";
import { newId, newToken } from "../ids";
import { validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit } from "./audit";
import { getTenant } from "./tenants";

/**
 * Website tracking (TRK-09): a first-party snippet on the merchant's own site reports what the
 * people affiliates send do there. Nothing is kept per visitor. The snippet remembers, in the
 * visitor's own browser, which stages it has already reported today (arrived, read half a page,
 * read to the bottom, reached the checkout), reports each one once, and the server only adds to
 * daily counters per affiliate and page. Purchases are not reported by the browser at all: they
 * are counted from the recorded sales.
 *
 * Everything the browser sends is untrusted: the tenant comes from the site key, the affiliate
 * only ever from a click token that resolves inside that tenant, origins are checked against the
 * workspace's domain list, and the counters are analytics, never money.
 */
export const JOURNEY_STAGES = ["visit", "half", "bottom", "checkout"] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

/** Snippet-generated ids: short, URL-safe, no lookalikes needed. */
export const VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_HITS_PER_BATCH = 50;
/** Distinct pages and distinct custom event names counted per workspace per day; the rest fold into "(other)" or are dropped. */
const MAX_PAGES_PER_DAY = 300;
const MAX_EVENT_NAMES_PER_DAY = 30;
export const OTHER_PAGE = "(other)";
const MAX_PAGE_LENGTH = 160;
/** How often the workspace's "last heard from the snippet" is refreshed. */
const TOUCH_EVERY_MS = 60_000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TrackingView {
  enabled: boolean;
  siteKey: string | null;
  domains: string[];
  pixelConversions: boolean;
  consentMode: "off" | "wait";
  checkoutPaths: string[];
  lastEventAt: Date | null;
  lastEventHost: string | null;
  visitors7d: number;
  checkouts7d: number;
}

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$|^localhost$/, "enter a hostname such as shop.example.com")
  .transform((h) => h.replace(/^www\./, ""));

/** "/buy", "buy" or a pasted "https://shop.example.com/buy?x=1" all become "/buy". */
const checkoutPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((v) => {
    let path = v;
    try {
      if (/^https?:\/\//i.test(v)) path = new URL(v).pathname;
    } catch {
      /* not a URL: treat as a path fragment */
    }
    path = path.split(/[?#]/)[0]!.toLowerCase();
    return path.startsWith("/") ? path : `/${path}`;
  })
  .refine((p) => p.length > 1 && p.length <= 80 && /^[a-z0-9/._~%-]+$/.test(p), "enter part of the checkout page's address, such as /buy");

export const trackingSettingsSchema = z
  .object({
    domains: z.array(hostname).max(20).optional(),
    pixelConversions: z.boolean().optional(),
    consentMode: z.enum(["off", "wait"]).optional(),
    checkoutPaths: z.array(checkoutPath).max(10).optional(),
  })
  .strict();

const DAY_MS = 86_400_000;
/** UTC calendar day, the grain the counters are kept at. */
export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

export async function getTracking(db: DbLike, ctx: TenantContext): Promise<TrackingView> {
  requirePerm(ctx, "read");
  const tenant = await getTenant(db, ctx);
  const since = dayOf(new Date(ctx.now().getTime() - 6 * DAY_MS));
  const rows = await db
    .select({ stage: journeyStats.stage, n: sql<number>`coalesce(sum(${journeyStats.count}), 0)`.mapWith(Number) })
    .from(journeyStats)
    .where(and(eq(journeyStats.tenantId, ctx.tenantId), eq(journeyStats.page, ""), inArray(journeyStats.stage, ["visit", "checkout"]), gte(journeyStats.day, since)))
    .groupBy(journeyStats.stage);
  const total = (stage: string) => rows.find((r) => r.stage === stage)?.n ?? 0;
  return {
    enabled: !!tenant.siteKey,
    siteKey: tenant.siteKey,
    domains: tenant.tracking?.domains ?? [],
    pixelConversions: !!tenant.tracking?.pixelConversions,
    consentMode: tenant.tracking?.consentMode ?? "off",
    checkoutPaths: tenant.tracking?.checkoutPaths ?? [],
    lastEventAt: tenant.trackingLastAt ?? null,
    lastEventHost: tenant.trackingLastHost ?? null,
    visitors7d: total("visit"),
    checkouts7d: total("checkout"),
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
  if (input.checkoutPaths !== undefined) next.checkoutPaths = [...new Set(input.checkoutPaths)];
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

/** Path segments that identify one order, product or person rather than a page: numbers, UUIDs, long hex or long tokens. */
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[a-z0-9_-]*\d)[a-z0-9_-]{20,})$/i;

/**
 * The page a hit belongs to, as "host/path": no query string or fragment (they carry click
 * tokens, order keys and emails), no "www.", no trailing slash, and id-like segments folded into
 * ":id" so every order-received page is one page rather than one per order.
 */
export function normalizePage(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (ID_SEGMENT.test(seg) ? ":id" : seg.toLowerCase()));
  const page = `${host}/${segments.join("/")}`.replace(/\/$/, "") || host;
  return page.length > MAX_PAGE_LENGTH ? `${page.slice(0, MAX_PAGE_LENGTH - 1)}…` : page;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const clientHit = z.object({
  /** The stage reached, or `event` for one of the site's own events (named in `n`). */
  s: z.enum([...JOURNEY_STAGES, "event"]),
  n: z.string().trim().min(1).max(40).optional(),
  url: z.string().max(2000).optional(),
  /** First time today this visitor reached the stage on this page, and anywhere on the site. The browser keeps that memory; the server keeps none. */
  page: z.boolean().optional(),
  site: z.boolean().optional(),
});

export const ingestSchema = z.object({
  /** Lets an order that carries the visitor id find this click later; nothing else is kept about the visitor. */
  visitorId: z.string().regex(VISITOR_ID).optional(),
  /** Click token from the landing URL or the snippet's first-party cookie. */
  ref: z.string().max(64).nullable().optional(),
  /** `granted` when the snippet runs in consent mode and the visitor agreed; `not_required` otherwise. */
  consent: z.enum(["granted", "not_required"]).optional(),
  hits: z.array(clientHit).min(1).max(MAX_HITS_PER_BATCH),
});
export type IngestInput = z.input<typeof ingestSchema>;

export interface IngestResult {
  /** Hits that added to a counter. */
  accepted: number;
  attributed: boolean;
  /** When the ref resolved: how long the snippet should keep it, from the program's attribution window. */
  ref: { ttlSeconds: number } | null;
  /** Set when the batch was refused: the workspace requires consent and the batch did not carry it, or no affiliate sent this visitor. */
  dropped?: "consent_required" | "no_affiliate" | "legacy";
}

export interface IngestOptions {
  /** The workspace's consent mode is `wait`: batches without `consent: "granted"` are dropped, whatever the page sent. */
  consentRequired?: boolean;
}

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.:-]*$/;

/**
 * Add a batch from the snippet to the day's counters. The request must already be scoped to the
 * tenant the site key resolved to. Batches from snippets older than v5 (per-visitor events) are
 * acknowledged and not counted: they carry no once-a-day memory, so counting them would inflate
 * every number for the hour a cached copy lives.
 */
export async function ingestHits(db: DbLike, ctx: TenantContext, rawInput: unknown, opts: IngestOptions = {}): Promise<IngestResult> {
  const legacy = !!rawInput && typeof rawInput === "object" && !("hits" in rawInput) && Array.isArray((rawInput as { events?: unknown }).events);
  const input = legacy ? null : ingestSchema.parse(rawInput);
  const consent = legacy ? (rawInput as { consent?: unknown }).consent : input!.consent;
  if (opts.consentRequired && consent !== "granted") return { accepted: 0, attributed: false, ref: null, dropped: "consent_required" };
  const ref = legacy ? (rawInput as { ref?: unknown }).ref : input!.ref;
  const click = typeof ref === "string" && ref ? await db.query.clicks.findFirst({ where: and(eq(clicks.tenantId, ctx.tenantId), eq(clicks.clickToken, ref)) }) : null;
  // Only visitors an affiliate sent are counted; anyone else is not Referly's business.
  if (!click) return { accepted: 0, attributed: false, ref: null, dropped: "no_affiliate" };
  const program = await db.query.programs.findFirst({ where: eq(programs.id, click.programId) });
  const refTtl = program ? { ttlSeconds: program.attributionWindowDays * 86_400 } : null;
  if (legacy) return { accepted: 0, attributed: true, ref: refTtl, dropped: "legacy" };

  const now = ctx.now();
  const day = dayOf(now);
  if (input!.visitorId && !click.visitorId) await db.update(clicks).set({ visitorId: input!.visitorId }).where(and(eq(clicks.id, click.id), isNull(clicks.visitorId)));

  // page + "\n" + stage -> how much to add. One visitor's batch rarely touches more than a handful of keys.
  const add = new Map<string, number>();
  const bump = (page: string, stage: string) => add.set(`${page}\n${stage}`, (add.get(`${page}\n${stage}`) ?? 0) + 1);
  let accepted = 0;
  let host: string | null = null;
  for (const hit of input!.hits) {
    if (!hit.page && !hit.site) continue;
    const page = normalizePage(hit.url);
    host ??= hit.url ? hostOf(hit.url) : null;
    if (hit.s === "event") {
      // The site's own events are counted by name for the whole site, once per visitor per day.
      if (!hit.site || !hit.n || !EVENT_NAME.test(hit.n)) continue;
      bump("", `event:${hit.n.replace(/\s+/g, " ")}`);
      accepted++;
      continue;
    }
    if (hit.site) {
      bump("", hit.s);
      // The first page of the day is where this visitor landed.
      if (hit.s === "visit" && page) bump(page, "land");
    }
    if (hit.page && page) bump(page, hit.s);
    accepted++;
  }
  if (add.size) await applyCounters(db, ctx, day, click.affiliateId, add);

  const tenant = await getTenant(db, ctx);
  if (!tenant.trackingLastAt || now.getTime() - tenant.trackingLastAt.getTime() >= TOUCH_EVERY_MS)
    await db.update(tenants).set({ trackingLastAt: now, trackingLastHost: host ?? tenant.trackingLastHost }).where(eq(tenants.id, ctx.tenantId));
  return { accepted, attributed: true, ref: refTtl };
}

/** Upserts the day's counters, keeping the number of distinct pages and event names a workspace can create in a day bounded. */
async function applyCounters(db: DbLike, ctx: TenantContext, day: string, affiliateId: string, add: Map<string, number>): Promise<void> {
  const today = and(eq(journeyStats.tenantId, ctx.tenantId), eq(journeyStats.day, day));
  const pages = [...new Set([...add.keys()].map((k) => k.split("\n")[0]!).filter((p) => p && p !== OTHER_PAGE))];
  const events = [...new Set([...add.keys()].map((k) => k.split("\n")[1]!).filter((s) => s.startsWith("event:")))];
  const fold = new Map<string, string>();
  if (pages.length) {
    const known = new Set((await db.selectDistinct({ page: journeyStats.page }).from(journeyStats).where(and(today, inArray(journeyStats.page, pages)))).map((r) => r.page));
    const fresh = pages.filter((p) => !known.has(p));
    if (fresh.length) {
      const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(distinct ${journeyStats.page})`.mapWith(Number) }).from(journeyStats).where(and(today, ne(journeyStats.page, "")));
      let room = Math.max(0, MAX_PAGES_PER_DAY - n);
      for (const p of fresh) {
        if (room > 0) room--;
        else fold.set(p, OTHER_PAGE);
      }
    }
  }
  const dropped = new Set<string>();
  if (events.length) {
    const known = new Set((await db.selectDistinct({ stage: journeyStats.stage }).from(journeyStats).where(and(today, inArray(journeyStats.stage, events)))).map((r) => r.stage));
    const fresh = events.filter((e) => !known.has(e));
    if (fresh.length) {
      const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(distinct ${journeyStats.stage})`.mapWith(Number) }).from(journeyStats).where(and(today, like(journeyStats.stage, "event:%")));
      let room = Math.max(0, MAX_EVENT_NAMES_PER_DAY - n);
      for (const e of fresh) {
        if (room > 0) room--;
        else dropped.add(e);
      }
    }
  }
  const final = new Map<string, number>();
  for (const [key, n] of add) {
    const [page, stage] = key.split("\n") as [string, string];
    if (dropped.has(stage)) continue;
    const k = `${fold.get(page) ?? page}\n${stage}`;
    final.set(k, (final.get(k) ?? 0) + n);
  }
  for (const [key, n] of final) {
    const [page, stage] = key.split("\n") as [string, string];
    await db
      .insert(journeyStats)
      .values({ id: newId("journeyStat"), tenantId: ctx.tenantId, day, affiliateId, page, stage, count: n })
      .onConflictDoUpdate({ target: [journeyStats.tenantId, journeyStats.day, journeyStats.affiliateId, journeyStats.page, journeyStats.stage], set: { count: sql`${journeyStats.count} + ${n}` } });
  }
}

/**
 * Click tokens this visitor arrived through, oldest first, for the attribution engine: an order
 * that carries the snippet's visitor id still finds its click after the ref cookie is gone.
 */
export async function visitorClickTokens(db: DbLike, ctx: TenantContext, visitorId: string): Promise<string[]> {
  const rows = await db
    .select({ token: clicks.clickToken })
    .from(clicks)
    .where(and(eq(clicks.tenantId, ctx.tenantId), eq(clicks.visitorId, visitorId)))
    .orderBy(desc(clicks.occurredAt))
    .limit(10);
  return rows.map((r) => r.token).reverse();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface JourneyFunnel {
  /** People who arrived through an affiliate link, counted once a day. */
  visitors: number;
  /** ...who read at least half of a page. */
  half: number;
  /** ...who read a page to the bottom. */
  bottom: number;
  /** ...who reached a checkout page. */
  checkout: number;
  /** Sales attributed to an affiliate's link in the period, from the recorded conversions. */
  purchases: number;
  /** What those sales were worth, per currency, largest number of sales first. Amounts in different currencies are never added together. */
  revenue: { currency: string; minor: number }[];
  /** Sign-ups (pay-per-lead) attributed to an affiliate's link. */
  leads: number;
}

export interface JourneyPageRow {
  page: string;
  /** People whose first page of the day this was. */
  landed: number;
  visitors: number;
  half: number;
  bottom: number;
  /** People counted as reaching the checkout on this page: non-zero marks a checkout page. */
  checkout: number;
}

export interface JourneyReport {
  days: number;
  since: Date;
  funnel: JourneyFunnel;
  /** Sales credited through a coupon code alone: real sales, but nobody arrived through a link, so they are not part of the funnel. */
  couponOnlySales: number;
  pages: JourneyPageRow[];
  /** The site's own events (`referly('track', name)`), by how many people triggered each. */
  events: { name: string; visitors: number }[];
}

export interface ReportFilter {
  /** Look-back in days; default 30. */
  days?: number;
  affiliateId?: string;
  /** Pages listed, busiest first. */
  pageLimit?: number;
}

export async function journeyReport(db: DbLike, ctx: TenantContext, filter: ReportFilter = {}): Promise<JourneyReport> {
  requirePerm(ctx, "read");
  const days = Math.min(Math.max(Math.trunc(filter.days ?? 30), 1), 400);
  const since = new Date(ctx.now().getTime() - days * DAY_MS);
  const rows = await db
    .select({ page: journeyStats.page, stage: journeyStats.stage, n: sql<number>`coalesce(sum(${journeyStats.count}), 0)`.mapWith(Number) })
    .from(journeyStats)
    .where(and(eq(journeyStats.tenantId, ctx.tenantId), gte(journeyStats.day, dayOf(since)), filter.affiliateId ? eq(journeyStats.affiliateId, filter.affiliateId) : undefined))
    .groupBy(journeyStats.page, journeyStats.stage);

  const site = (stage: string) => rows.find((r) => r.page === "" && r.stage === stage)?.n ?? 0;
  const byPage = new Map<string, JourneyPageRow>();
  for (const r of rows) {
    if (!r.page) continue;
    const row = byPage.get(r.page) ?? { page: r.page, landed: 0, visitors: 0, half: 0, bottom: 0, checkout: 0 };
    if (r.stage === "visit") row.visitors = r.n;
    else if (r.stage === "land") row.landed = r.n;
    else if (r.stage === "half") row.half = r.n;
    else if (r.stage === "bottom") row.bottom = r.n;
    else if (r.stage === "checkout") row.checkout = r.n;
    byPage.set(r.page, row);
  }
  const events = rows
    .filter((r) => r.page === "" && r.stage.startsWith("event:"))
    .map((r) => ({ name: r.stage.slice("event:".length), visitors: r.n }))
    .sort((a, b) => b.visitors - a.visitors || a.name.localeCompare(b.name));

  // Purchases come from the sales themselves, never from the browser. Only sales a link click earned
  // belong to a funnel of link visitors; sales typed in by hand or imported never were site visits.
  const onSite = and(
    eq(conversions.tenantId, ctx.tenantId),
    gte(conversions.occurredAt, since),
    isNotNull(conversions.affiliateId),
    eq(conversions.isTest, false),
    ne(conversions.status, "cancelled"),
    notInArray(conversions.source, ["manual", "import"]),
    filter.affiliateId ? eq(conversions.affiliateId, filter.affiliateId) : undefined,
  );
  const sales = await db
    .select({
      kind: conversions.kind,
      via: conversions.attributionSource,
      currency: conversions.currency,
      n: sql<number>`count(*)`.mapWith(Number),
      minor: sql<number>`coalesce(sum(${conversions.amountMinor}), 0)`.mapWith(Number),
    })
    .from(conversions)
    .where(onSite)
    .groupBy(conversions.kind, conversions.attributionSource, conversions.currency);
  const total = (kind: string, via: string) => sales.filter((s) => s.kind === kind && s.via === via).reduce((n, s) => n + s.n, 0);
  const linkSales = sales.filter((s) => s.kind === "sale" && s.via === "link").sort((a, b) => b.n - a.n || a.currency.localeCompare(b.currency));

  return {
    days,
    since,
    funnel: {
      visitors: site("visit"),
      half: site("half"),
      bottom: site("bottom"),
      checkout: site("checkout"),
      purchases: total("sale", "link"),
      revenue: linkSales.map((s) => ({ currency: s.currency, minor: s.minor })),
      leads: total("lead", "link"),
    },
    couponOnlySales: total("sale", "coupon"),
    pages: [...byPage.values()].sort((a, b) => b.visitors - a.visitors || b.landed - a.landed || a.page.localeCompare(b.page)).slice(0, Math.min(filter.pageLimit ?? 50, 300)),
    events,
  };
}
