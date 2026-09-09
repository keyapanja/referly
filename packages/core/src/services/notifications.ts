import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { affiliates, notifications, offers, programs, users, type Notification, type NotificationPrefs } from "../db/schema";
import { newId } from "../ids";
import { notFound } from "../errors";
import { type TenantContext, requireAffiliate } from "../context";
import type { DomainEvent, DomainEventType } from "./events";

/**
 * In-app notification centre (MSG-06). Every domain event that someone should see becomes a
 * row per recipient: affiliates get their own account, earnings, payout, campaign, dispute and
 * program news; merchant team members get applications, sales, disputes, failed payouts and
 * new tasks. Each recipient switches categories off for the in-app feed and (affiliates) for
 * email; account and security emails are never switchable. The bell in the app polls the
 * unread count; the notifications page lists, marks read and holds the preferences.
 */
export type Audience = "merchant" | "affiliate";

export interface Category {
  key: string;
  audience: Audience;
  label: string;
  description: string;
  /** Merchant roles that receive this category. */
  roles?: readonly string[];
  /** Whether the category also drives an email (affiliates only today). */
  email: boolean;
}

export const CATEGORIES: readonly Category[] = [
  { key: "applications", audience: "merchant", label: "Applications", description: "New affiliate applications and program joins", roles: ["owner", "admin", "marketing"], email: false },
  { key: "sales", audience: "merchant", label: "Sales", description: "Attributed sales, refunds and cancellations", roles: ["owner", "admin", "marketing"], email: false },
  { key: "disputes", audience: "merchant", label: "Disputes", description: "Disputes opened, replied to or withdrawn by affiliates", roles: ["owner", "admin"], email: false },
  { key: "payouts", audience: "merchant", label: "Payouts", description: "Provider payouts that failed", roles: ["owner", "admin"], email: false },
  { key: "tasks", audience: "merchant", label: "Tasks", description: "Tasks created by automation, disputes, webhooks and data requests", roles: ["owner", "admin", "marketing"], email: false },
  { key: "account", audience: "affiliate", label: "Account", description: "Approval, rejection, suspension and reactivation", email: true },
  { key: "earnings", audience: "affiliate", label: "Earnings", description: "Sales attributed to you and commissions approved or reversed", email: true },
  { key: "affiliate_payouts", audience: "affiliate", label: "Payouts", description: "Payouts sent to you", email: true },
  { key: "campaigns", audience: "affiliate", label: "Campaigns", description: "Campaign invitations", email: true },
  { key: "affiliate_disputes", audience: "affiliate", label: "Disputes", description: "Updates on disputes that involve your sales", email: true },
  { key: "program", audience: "affiliate", label: "Program updates", description: "Changes to program terms and rates", email: true },
];

export function categoriesFor(audience: Audience): Category[] {
  return CATEGORIES.filter((c) => c.audience === audience);
}

/** Which category an event's email (the built-in notification rules in the worker) belongs to; undefined = always sent. */
export const EMAIL_CATEGORY: Partial<Record<DomainEventType, string>> = {
  "affiliate.approved": "account",
  "affiliate.rejected": "account",
  "conversion.created": "earnings",
  "commission.approved": "earnings",
  "commission.reversed": "earnings",
  "payout.paid": "affiliate_payouts",
  "program.updated": "program",
  "campaign.invited": "campaigns",
  "dispute.opened": "affiliate_disputes",
  "dispute.commented": "affiliate_disputes",
  "dispute.resolved": "affiliate_disputes",
};

export function wants(prefs: NotificationPrefs | null | undefined, category: string, channel: "inApp" | "email"): boolean {
  return prefs?.[category]?.[channel] !== false;
}

const prefSchema = z.object({ inApp: z.boolean().optional(), email: z.boolean().optional() });
export const prefsSchema = z.record(z.string(), prefSchema);

const fmt = (minor: number | null | undefined, currency: string | null | undefined) => (typeof minor === "number" ? `${(minor / 100).toFixed(2)} ${currency ?? ""}`.trim() : "");

interface Draft {
  category: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

/**
 * Build the merchant-facing and affiliate-facing drafts for an event. Names are looked up so
 * the row reads well without a join; the link is a web-app path.
 */
async function draftsFor(db: DbLike, event: DomainEvent): Promise<{ merchant: Draft | null; affiliate: Draft | null }> {
  const d = event.data;
  const affiliateId = (d.affiliateId as string | null | undefined) ?? (event.entityType === "affiliate" ? event.entityId : null);
  const affiliate = affiliateId ? await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, event.tenantId)) }) : null;
  const name = affiliate?.name ?? "An affiliate";
  const programId = d.programId as string | undefined;
  const program = programId ? await db.query.programs.findFirst({ where: and(eq(programs.id, programId), eq(programs.tenantId, event.tenantId)) }) : null;
  const amount = fmt(d.amountMinor as number | undefined, d.currency as string | undefined);
  const reason = (d.reason as string | undefined) ?? "";
  const byAffiliate = d.raisedBy === "affiliate" || event.actor.type === "affiliate";

  switch (event.type) {
    case "affiliate.applied":
      return { merchant: { category: "applications", title: `${name} applied${program ? ` to ${program.name}` : ""}`, body: affiliate?.email ?? null, link: affiliateId ? `/app/affiliates/${affiliateId}` : "/app/affiliates" }, affiliate: null };
    case "affiliate.joined_program":
      return { merchant: { category: "applications", title: `${name} joined ${program?.name ?? "a program"}`, link: affiliateId ? `/app/affiliates/${affiliateId}` : "/app/affiliates" }, affiliate: null };
    case "affiliate.approved":
      return { merchant: null, affiliate: { category: "account", title: `You're in${program ? `: ${program.name}` : ""}`, body: "Your affiliate account is active. Grab your links and start sharing.", link: "/portal/links" } };
    case "affiliate.rejected":
      return { merchant: null, affiliate: { category: "account", title: "Your application was not accepted", body: reason || null, link: "/portal" } };
    case "affiliate.suspended":
      return { merchant: null, affiliate: { category: "account", title: "Your account was suspended", body: reason || null, link: "/portal" } };
    case "affiliate.reactivated":
      return { merchant: null, affiliate: { category: "account", title: "Your account is active again", link: "/portal" } };
    case "conversion.created": {
      const offerId = d.offerId as string | undefined;
      const offer = offerId ? await db.query.offers.findFirst({ where: and(eq(offers.id, offerId), eq(offers.tenantId, event.tenantId)) }) : null;
      const what = `${amount}${offer ? ` · ${offer.name}` : ""}`;
      return {
        merchant: { category: "sales", title: affiliateId ? `Sale attributed to ${name}` : "Unattributed sale recorded", body: what, link: `/app/conversions` },
        affiliate: affiliateId && d.commissionId ? { category: "earnings", title: "A sale was attributed to you", body: what, link: "/portal/conversions" } : null,
      };
    }
    case "conversion.refunded":
      return { merchant: { category: "sales", title: "A sale was refunded", body: fmt(d.refundMinor as number | undefined, d.currency as string | undefined) || null, link: "/app/conversions" }, affiliate: null };
    case "conversion.cancelled":
      return { merchant: { category: "sales", title: "A sale was cancelled", body: reason || null, link: "/app/conversions" }, affiliate: null };
    case "commission.approved":
      return { merchant: null, affiliate: { category: "earnings", title: `Commission approved: ${amount}`, body: "It becomes payable once the holding period ends.", link: "/portal/earnings" } };
    case "commission.reversed":
      return { merchant: null, affiliate: { category: "earnings", title: `Commission reversed: ${amount}`, body: reason || null, link: "/portal/earnings" } };
    case "payout.paid":
      return { merchant: null, affiliate: { category: "affiliate_payouts", title: `Payout sent: ${amount}`, link: "/portal/payouts" } };
    case "payout.failed":
      return { merchant: { category: "payouts", title: `Payout to ${name} failed`, body: reason || null, link: "/app/payouts" }, affiliate: null };
    case "campaign.invited": {
      const campaignName = (d.campaignName as string | undefined) ?? "a campaign";
      return { merchant: null, affiliate: { category: "campaigns", title: `You're invited to ${campaignName}`, link: "/portal/campaigns" } };
    }
    case "program.updated": {
      const prog = event.entityType === "program" ? await db.query.programs.findFirst({ where: and(eq(programs.id, event.entityId), eq(programs.tenantId, event.tenantId)) }) : null;
      return { merchant: null, affiliate: { category: "program", title: `${prog?.name ?? "Program"} terms were updated`, body: "Review the new terms in the portal.", link: "/portal/offers" } };
    }
    case "dispute.opened":
      return {
        merchant: byAffiliate ? { category: "disputes", title: `${name} opened a ${String(d.kind ?? "")} dispute`.replace("  ", " "), body: reason.replace(/^We received your [^:]+: /, "") || null, link: `/app/disputes/${event.entityId}` } : null,
        affiliate: { category: "affiliate_disputes", title: byAffiliate ? "We received your dispute" : "A sale attributed to you is under review", body: reason.replace(/^[^:]+: /, "") || null, link: `/portal/disputes/${event.entityId}` },
      };
    case "dispute.commented":
      return {
        merchant: byAffiliate ? { category: "disputes", title: `${name} replied on a dispute`, body: reason.slice(0, 200) || null, link: `/app/disputes/${event.entityId}` } : null,
        affiliate: byAffiliate ? null : { category: "affiliate_disputes", title: "New reply on your dispute", body: reason.slice(0, 200) || null, link: `/portal/disputes/${event.entityId}` },
      };
    case "dispute.resolved":
      return { merchant: null, affiliate: { category: "affiliate_disputes", title: `Dispute ${String(d.resolution ?? "resolved")}`, body: reason.replace(/^Your dispute was [a-z]+\. /, "") || null, link: `/portal/disputes/${event.entityId}` } };
    case "dispute.withdrawn":
      return { merchant: { category: "disputes", title: `${name} withdrew a dispute`, link: `/app/disputes/${event.entityId}` }, affiliate: null };
    default:
      return { merchant: null, affiliate: null };
  }
}

/** Fan an event out to everyone who should see it in the app. Called by the worker inside the tenant scope. */
export async function fanOutForEvent(db: DbLike, ctx: TenantContext, event: DomainEvent): Promise<Notification[]> {
  const { merchant, affiliate } = await draftsFor(db, event);
  const out: Notification[] = [];
  const now = ctx.now();
  const base = { tenantId: ctx.tenantId, type: event.type, entityType: event.entityType, entityId: event.entityId, createdAt: now };
  if (merchant) {
    const cat = CATEGORIES.find((c) => c.key === merchant.category)!;
    const team = await db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), eq(users.status, "active"), inArray(users.role, [...(cat.roles ?? ["owner", "admin"])])));
    for (const u of team) {
      if (!wants(u.notificationPrefs, merchant.category, "inApp")) continue;
      const [row] = await db.insert(notifications).values({ id: newId("notification"), ...base, recipientType: "user", recipientId: u.id, category: merchant.category, title: merchant.title, body: merchant.body ?? null, link: merchant.link ?? null }).returning();
      out.push(row!);
    }
  }
  if (affiliate) {
    const affiliateId = (event.data.affiliateId as string | null | undefined) ?? (event.entityType === "affiliate" ? event.entityId : null);
    const a = affiliateId ? await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, affiliateId), eq(affiliates.tenantId, ctx.tenantId)) }) : null;
    if (a && !a.erasedAt && wants(a.notificationPrefs, affiliate.category, "inApp")) {
      const [row] = await db.insert(notifications).values({ id: newId("notification"), ...base, recipientType: "affiliate", recipientId: a.id, category: affiliate.category, title: affiliate.title, body: affiliate.body ?? null, link: affiliate.link ?? null }).returning();
      out.push(row!);
    }
  }
  return out;
}

/** A new task for the team: everyone who handles tasks sees it. */
export async function notifyTask(db: DbLike, ctx: TenantContext, task: { id: string; title: string; note?: string | null }): Promise<void> {
  const cat = CATEGORIES.find((c) => c.key === "tasks")!;
  const team = await db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), eq(users.status, "active"), inArray(users.role, [...cat.roles!])));
  for (const u of team) {
    if (!wants(u.notificationPrefs, "tasks", "inApp")) continue;
    await db.insert(notifications).values({ id: newId("notification"), tenantId: ctx.tenantId, recipientType: "user", recipientId: u.id, category: "tasks", type: "task", title: `New task: ${task.title}`, body: task.note?.slice(0, 200) ?? null, link: "/app", entityType: "task", entityId: task.id, createdAt: ctx.now() });
  }
}

export interface Recipient {
  type: "user" | "affiliate";
  id: string;
}

function recipientScope(ctx: TenantContext, r: Recipient) {
  if (r.type === "affiliate") requireAffiliate(ctx, r.id);
  return and(eq(notifications.tenantId, ctx.tenantId), eq(notifications.recipientType, r.type), eq(notifications.recipientId, r.id));
}

export async function listNotifications(db: DbLike, ctx: TenantContext, r: Recipient, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
  const scope = recipientScope(ctx, r);
  return db
    .select()
    .from(notifications)
    .where(opts.unreadOnly ? and(scope, isNull(notifications.readAt)) : scope)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(Math.min(opts.limit ?? 50, 200));
}

export async function unreadCount(db: DbLike, ctx: TenantContext, r: Recipient): Promise<number> {
  const [row] = await db.select({ n: count() }).from(notifications).where(and(recipientScope(ctx, r), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** Mark some (ids) or all of a recipient's notifications read. Ids that belong to someone else are ignored. */
export async function markRead(db: DbLike, ctx: TenantContext, r: Recipient, input: { ids?: string[]; all?: boolean }): Promise<number> {
  const scope = and(recipientScope(ctx, r), isNull(notifications.readAt));
  if (!input.all && !input.ids?.length) return 0;
  const rows = await db
    .update(notifications)
    .set({ readAt: ctx.now() })
    .where(input.all ? scope : and(scope, inArray(notifications.id, input.ids!)))
    .returning({ id: notifications.id });
  return rows.length;
}

export async function getPrefs(db: DbLike, ctx: TenantContext, r: Recipient): Promise<{ audience: Audience; categories: Category[]; prefs: NotificationPrefs }> {
  if (r.type === "affiliate") {
    requireAffiliate(ctx, r.id);
    const a = await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, r.id), eq(affiliates.tenantId, ctx.tenantId)) });
    if (!a) throw notFound("affiliate", r.id);
    return { audience: "affiliate", categories: categoriesFor("affiliate"), prefs: a.notificationPrefs ?? {} };
  }
  const u = await db.query.users.findFirst({ where: and(eq(users.id, r.id), eq(users.tenantId, ctx.tenantId)) });
  if (!u) throw notFound("user", r.id);
  return { audience: "merchant", categories: categoriesFor("merchant").filter((c) => !c.roles || c.roles.includes(u.role)), prefs: u.notificationPrefs ?? {} };
}

export async function updatePrefs(db: DbLike, ctx: TenantContext, r: Recipient, rawInput: unknown): Promise<NotificationPrefs> {
  const input = prefsSchema.parse(rawInput);
  const current = await getPrefs(db, ctx, r);
  const allowed = new Set(current.categories.map((c) => c.key));
  const next: NotificationPrefs = { ...current.prefs };
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    const merged = { ...(next[key] ?? {}), ...value };
    if (merged.inApp !== false) delete merged.inApp;
    if (merged.email !== false) delete merged.email;
    if (Object.keys(merged).length === 0) delete next[key];
    else next[key] = merged;
  }
  if (r.type === "affiliate") await db.update(affiliates).set({ notificationPrefs: next, updatedAt: ctx.now() }).where(and(eq(affiliates.id, r.id), eq(affiliates.tenantId, ctx.tenantId)));
  else await db.update(users).set({ notificationPrefs: next, updatedAt: ctx.now() }).where(and(eq(users.id, r.id), eq(users.tenantId, ctx.tenantId)));
  return next;
}

/** Retention: notifications older than the cutoff, read or not. */
export async function pruneNotifications(db: DbLike, tenantId: string, before: Date): Promise<number> {
  const rows = await db.delete(notifications).where(and(eq(notifications.tenantId, tenantId), lt(notifications.createdAt, before))).returning({ id: notifications.id });
  return rows.length;
}
