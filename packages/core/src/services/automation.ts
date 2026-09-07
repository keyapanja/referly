import { and, count, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { withTx } from "../db/client";
import { affiliates, automationRules, automationRuns, campaigns, commissions, conversions, offers, payouts, programs, tasks, tenants, type AutomationRule, type AutomationRun, type Task } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, tenantContext } from "../context";
import { writeAudit, snapshot } from "./audit";
import type { DomainEvent, DomainEventType } from "./events";
import * as messaging from "./messaging";
import * as affiliatesSvc from "./affiliates";
import * as commissionsSvc from "./commissions";
import * as conversionsSvc from "./conversions";
import { assertFeature } from "./plans";
import { groupIdsForAffiliate } from "./groups";

/**
 * Rules & automation engine (AUTO-01..06). A rule = trigger event + conditions + actions +
 * stop conditions. Rules run in the worker after the event is stored, so every automated
 * action traces back to a stored event, a stored rule and a run record (PRD s2 "explainable
 * automation"). Deterministic only: no generative AI anywhere in this file.
 */

/** Actor id stamped on everything a rule does, so rules never trigger themselves in a loop. */
export const AUTOMATION_ACTOR = "automation";

export const TRIGGERS = [
  { type: "affiliate.applied", label: "Affiliate applied" },
  { type: "affiliate.approved", label: "Affiliate approved" },
  { type: "affiliate.suspended", label: "Affiliate suspended" },
  { type: "affiliate.joined_program", label: "Affiliate joined a program" },
  { type: "conversion.created", label: "Conversion recorded" },
  { type: "conversion.refunded", label: "Conversion refunded" },
  { type: "commission.created", label: "Commission created" },
  { type: "commission.approved", label: "Commission approved" },
  { type: "commission.payable", label: "Commission became payable" },
  { type: "commission.reversed", label: "Commission reversed" },
  { type: "payout.paid", label: "Payout paid" },
  { type: "payout.failed", label: "Payout failed" },
  { type: "campaign.started", label: "Campaign started" },
  { type: "campaign.ended", label: "Campaign ended" },
] as const satisfies readonly { type: DomainEventType; label: string }[];
export type TriggerType = (typeof TRIGGERS)[number]["type"];
const TRIGGER_TYPES = TRIGGERS.map((t) => t.type) as [TriggerType, ...TriggerType[]];

export const CONDITION_FIELDS = [
  { key: "programId", label: "Program", kind: "id" },
  { key: "offerId", label: "Offer", kind: "id" },
  { key: "campaignId", label: "Campaign", kind: "id" },
  { key: "affiliateId", label: "Affiliate", kind: "id" },
  { key: "affiliateTag", label: "Affiliate tag", kind: "string" },
  { key: "affiliateGroup", label: "Affiliate group", kind: "id" },
  { key: "affiliateStatus", label: "Affiliate status", kind: "string" },
  { key: "amountMinor", label: "Amount (minor units)", kind: "number" },
  { key: "status", label: "Entity status", kind: "string" },
  { key: "source", label: "Attribution source", kind: "string" },
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number]["key"];
const FIELD_KEYS = CONDITION_FIELDS.map((f) => f.key) as [ConditionField, ...ConditionField[]];

export const OPS = ["eq", "neq", "in", "not_in", "gte", "lte"] as const;
export type Op = (typeof OPS)[number];

export const conditionSchema = z.object({
  field: z.enum(FIELD_KEYS),
  op: z.enum(OPS),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
});
export type Condition = z.infer<typeof conditionSchema>;

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_template"), templateKey: z.enum(messaging.TEMPLATE_KEYS) }),
  z.object({ type: z.literal("send_custom"), subject: z.string().min(1).max(200), body: z.string().min(1).max(10000) }),
  z.object({ type: z.literal("approve_commission") }),
  z.object({ type: z.literal("approve_conversion") }),
  z.object({ type: z.literal("add_tag"), tag: z.string().min(1).max(40) }),
  z.object({ type: z.literal("remove_tag"), tag: z.string().min(1).max(40) }),
  z.object({ type: z.literal("adjust_balance"), amountMinor: z.number().int().refine((n) => n !== 0, "amount cannot be zero"), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal("create_task"), title: z.string().min(1).max(200), note: z.string().max(2000).optional() }),
  z.object({ type: z.literal("suspend_affiliate"), reason: z.string().min(1).max(500) }),
]);
export type Action = z.infer<typeof actionSchema>;

export const ACTIONS = [
  { type: "send_template", label: "Send a template email to the affiliate", params: [{ key: "templateKey", label: "Template", kind: "template" }] },
  { type: "send_custom", label: "Send a custom email to the affiliate", params: [{ key: "subject", label: "Subject", kind: "string" }, { key: "body", label: "Body", kind: "text" }] },
  { type: "approve_commission", label: "Approve the commission", params: [] },
  { type: "approve_conversion", label: "Approve the conversion", params: [] },
  { type: "add_tag", label: "Add a tag to the affiliate", params: [{ key: "tag", label: "Tag", kind: "string" }] },
  { type: "remove_tag", label: "Remove a tag from the affiliate", params: [{ key: "tag", label: "Tag", kind: "string" }] },
  { type: "adjust_balance", label: "Adjust the affiliate's balance", params: [{ key: "amountMinor", label: "Amount (minor units, negative to deduct)", kind: "number" }, { key: "reason", label: "Reason", kind: "string" }] },
  { type: "create_task", label: "Create a task for the team", params: [{ key: "title", label: "Title", kind: "string" }, { key: "note", label: "Note", kind: "text" }] },
  { type: "suspend_affiliate", label: "Suspend the affiliate", params: [{ key: "reason", label: "Reason", kind: "string" }] },
] as const;

export const stopSchema = z.object({
  /** Never run twice for the same entity (conversion, commission, affiliate…). */
  oncePerEntity: z.boolean().default(true),
  /** Never run twice for the same affiliate, whatever the entity. */
  oncePerAffiliate: z.boolean().default(false),
  /** Do nothing when the affiliate is in one of these states. */
  skipIfAffiliateStatusIn: z.array(z.string()).default(["suspended", "rejected"]),
  activeFrom: z.coerce.date().nullable().optional(),
  activeUntil: z.coerce.date().nullable().optional(),
});
export type StopConditions = z.infer<typeof stopSchema>;

export const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  trigger: z.enum(TRIGGER_TYPES),
  conditions: z.array(conditionSchema).default([]),
  actions: z.array(actionSchema).min(1),
  stop: stopSchema.optional(),
  enabled: z.boolean().default(true),
});
const defaultStop = (): StopConditions => stopSchema.parse({});
export type RuleInput = z.input<typeof ruleSchema>;

export const CATALOG = { triggers: TRIGGERS, fields: CONDITION_FIELDS, ops: OPS, actions: ACTIONS, templates: messaging.TEMPLATE_KEYS, variables: messaging.TEMPLATE_VARIABLES };

// ---------------------------------------------------------------------------
// Rule CRUD (AUTO-06: pause/disable without deleting history)
// ---------------------------------------------------------------------------

function validateActions(actions: Action[]) {
  for (const a of actions) {
    if (a.type === "send_custom") {
      messaging.validateTemplateText(a.subject);
      messaging.validateTemplateText(a.body);
    }
  }
}

export async function createRule(db: DbLike, ctx: TenantContext, rawInput: RuleInput): Promise<AutomationRule> {
  requirePerm(ctx, "automation.write");
  const input = ruleSchema.parse(rawInput);
  await assertFeature(db, ctx, "automation");
  validateActions(input.actions);
  const [row] = await db
    .insert(automationRules)
    .values({ id: newId("automationRule"), tenantId: ctx.tenantId, name: input.name, trigger: input.trigger, conditions: input.conditions, actions: input.actions, stopConditions: [input.stop ?? defaultStop()], enabled: input.enabled, createdAt: ctx.now(), updatedAt: ctx.now() })
    .returning();
  await writeAudit(db, ctx, { entityType: "automation_rule", entityId: row!.id, action: "created", after: snapshot(row!) });
  return row!;
}

export async function updateRule(db: DbLike, ctx: TenantContext, ruleId: string, rawInput: Partial<RuleInput>): Promise<AutomationRule> {
  requirePerm(ctx, "automation.write");
  const before = await getRule(db, ctx, ruleId);
  const merged = ruleSchema.parse({ name: before.name, trigger: before.trigger, conditions: before.conditions, actions: before.actions, stop: before.stopConditions[0] ?? {}, enabled: before.enabled, ...rawInput });
  validateActions(merged.actions);
  const [after] = await db
    .update(automationRules)
    .set({ name: merged.name, trigger: merged.trigger, conditions: merged.conditions, actions: merged.actions, stopConditions: [merged.stop ?? defaultStop()], enabled: merged.enabled, updatedAt: ctx.now() })
    .where(and(eq(automationRules.id, ruleId), eq(automationRules.tenantId, ctx.tenantId)))
    .returning();
  await writeAudit(db, ctx, { entityType: "automation_rule", entityId: ruleId, action: "updated", before: snapshot(before), after: snapshot(after!) });
  return after!;
}

export async function setRuleEnabled(db: DbLike, ctx: TenantContext, ruleId: string, enabled: boolean, reason?: string): Promise<AutomationRule> {
  requirePerm(ctx, "automation.write");
  const before = await getRule(db, ctx, ruleId);
  const [after] = await db.update(automationRules).set({ enabled, updatedAt: ctx.now() }).where(eq(automationRules.id, ruleId)).returning();
  await writeAudit(db, ctx, { entityType: "automation_rule", entityId: ruleId, action: enabled ? "enabled" : "disabled", before: { enabled: before.enabled }, after: { enabled }, reason });
  return after!;
}

export async function getRule(db: DbLike, ctx: TenantContext, ruleId: string): Promise<AutomationRule> {
  const row = await db.query.automationRules.findFirst({ where: and(eq(automationRules.id, ruleId), eq(automationRules.tenantId, ctx.tenantId)) });
  if (!row) throw notFound("automation rule", ruleId);
  return row;
}

export async function listRules(db: DbLike, ctx: TenantContext) {
  requirePerm(ctx, "read");
  const rules = await db.select().from(automationRules).where(eq(automationRules.tenantId, ctx.tenantId)).orderBy(desc(automationRules.createdAt));
  const stats = await db
    .select({ ruleId: automationRuns.ruleId, runs: count(), matched: sql<number>`sum(case when ${automationRuns.status} = 'success' then 1 else 0 end)`, failed: sql<number>`sum(case when ${automationRuns.status} = 'failed' then 1 else 0 end)`, lastRunAt: max(automationRuns.createdAt) })
    .from(automationRuns)
    .where(eq(automationRuns.tenantId, ctx.tenantId))
    .groupBy(automationRuns.ruleId);
  return rules.map((r) => {
    const s = stats.find((x) => x.ruleId === r.id);
    return { ...r, stop: r.stopConditions[0] ?? {}, stats: { runs: s?.runs ?? 0, succeeded: Number(s?.matched ?? 0), failed: Number(s?.failed ?? 0), lastRunAt: s?.lastRunAt ?? null } };
  });
}

/** AUTO-05: what ran, why, what it did, whether it succeeded. */
export async function listRuns(db: DbLike, ctx: TenantContext, ruleId: string, limit = 100): Promise<AutomationRun[]> {
  requirePerm(ctx, "read");
  await getRule(db, ctx, ruleId);
  return db.select().from(automationRuns).where(and(eq(automationRuns.tenantId, ctx.tenantId), eq(automationRuns.ruleId, ruleId))).orderBy(desc(automationRuns.createdAt)).limit(limit);
}

// ---------------------------------------------------------------------------
// Tasks (AUTO-03 "create task/notification")
// ---------------------------------------------------------------------------

export async function createTask(db: DbLike, ctx: TenantContext, input: { title: string; note?: string | null; entityType?: string | null; entityId?: string | null; affiliateId?: string | null; ruleId?: string | null }): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({ id: newId("task"), tenantId: ctx.tenantId, title: input.title, note: input.note ?? null, status: "open", entityType: input.entityType ?? null, entityId: input.entityId ?? null, affiliateId: input.affiliateId ?? null, ruleId: input.ruleId ?? null, createdAt: ctx.now() })
    .returning();
  return row!;
}

export async function listTasks(db: DbLike, ctx: TenantContext, filter: { status?: "open" | "done"; limit?: number } = {}): Promise<Task[]> {
  requirePerm(ctx, "read");
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.tenantId, ctx.tenantId), filter.status ? eq(tasks.status, filter.status) : undefined))
    .orderBy(desc(tasks.createdAt))
    .limit(filter.limit ?? 100);
}

export async function completeTask(db: DbLike, ctx: TenantContext, taskId: string): Promise<Task> {
  requirePerm(ctx, "read");
  const [row] = await db.update(tasks).set({ status: "done", doneAt: ctx.now() }).where(and(eq(tasks.id, taskId), eq(tasks.tenantId, ctx.tenantId))).returning();
  if (!row) throw notFound("task", taskId);
  return row;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface Facts {
  affiliateId: string | null;
  affiliateName: string | null;
  affiliateEmail: string | null;
  affiliateTags: string[];
  affiliateGroups: string[];
  affiliateStatus: string | null;
  programId: string | null;
  programName: string | null;
  offerId: string | null;
  offerName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  conversionId: string | null;
  commissionId: string | null;
  payoutId: string | null;
  amountMinor: number | null;
  currency: string | null;
  status: string | null;
  source: string | null;
}

/** Everything a condition or action may need, resolved once per event. */
export async function buildFacts(db: DbLike, ctx: TenantContext, event: DomainEvent): Promise<Facts> {
  const d = event.data;
  const f: Facts = {
    affiliateId: (d.affiliateId as string | undefined) ?? (event.entityType === "affiliate" ? event.entityId : null),
    affiliateName: null,
    affiliateEmail: null,
    affiliateTags: [],
    affiliateGroups: [],
    affiliateStatus: null,
    programId: (d.programId as string | undefined) ?? null,
    programName: null,
    offerId: (d.offerId as string | undefined) ?? null,
    offerName: null,
    campaignId: (d.campaignId as string | undefined) ?? (event.entityType === "campaign" ? event.entityId : null),
    campaignName: (d.campaignName as string | undefined) ?? null,
    conversionId: (d.conversionId as string | undefined) ?? (event.entityType === "conversion" ? event.entityId : null),
    commissionId: (d.commissionId as string | undefined) ?? (event.entityType === "commission" ? event.entityId : null),
    payoutId: event.entityType === "payout" ? event.entityId : null,
    amountMinor: (d.amountMinor as number | undefined) ?? (d.deltaMinor as number | undefined) ?? null,
    currency: (d.currency as string | undefined) ?? null,
    status: (d.status as string | undefined) ?? null,
    source: null,
  };
  if (f.commissionId) {
    const c = await db.query.commissions.findFirst({ where: and(eq(commissions.id, f.commissionId), eq(commissions.tenantId, ctx.tenantId)) });
    if (c) {
      f.conversionId ??= c.conversionId;
      f.affiliateId ??= c.affiliateId;
      f.programId ??= c.programId;
      f.campaignId ??= c.campaignId;
      f.amountMinor ??= c.amountMinor;
      f.currency ??= c.currency;
      if (event.entityType === "commission") f.status ??= c.status;
    }
  }
  if (f.conversionId) {
    const c = await db.query.conversions.findFirst({ where: and(eq(conversions.id, f.conversionId), eq(conversions.tenantId, ctx.tenantId)) });
    if (c) {
      f.affiliateId ??= c.affiliateId;
      f.programId ??= c.programId;
      f.offerId ??= c.offerId;
      f.campaignId ??= c.campaignId;
      f.amountMinor ??= c.amountMinor;
      f.currency ??= c.currency;
      f.source = c.attributionSource;
      if (event.entityType === "conversion") f.status ??= c.status;
    }
  }
  if (f.payoutId) {
    const p = await db.query.payouts.findFirst({ where: and(eq(payouts.id, f.payoutId), eq(payouts.tenantId, ctx.tenantId)) });
    if (p) {
      f.affiliateId ??= p.affiliateId;
      f.amountMinor ??= p.amountMinor;
      f.currency ??= p.currency;
      f.status ??= p.status;
    }
  }
  if (f.affiliateId) {
    const a = await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, f.affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
    if (a) {
      f.affiliateName = a.name;
      f.affiliateEmail = a.email;
      f.affiliateTags = a.tags ?? [];
      f.affiliateGroups = await groupIdsForAffiliate(db, ctx, a.id);
      f.affiliateStatus = a.status;
      if (event.entityType === "affiliate") f.status ??= a.status;
    }
  }
  if (f.programId) f.programName = (await db.query.programs.findFirst({ where: eq(programs.id, f.programId) }))?.name ?? null;
  if (f.offerId) f.offerName = (await db.query.offers.findFirst({ where: eq(offers.id, f.offerId) }))?.name ?? null;
  if (f.campaignId && !f.campaignName) f.campaignName = (await db.query.campaigns.findFirst({ where: eq(campaigns.id, f.campaignId) }))?.name ?? null;
  return f;
}

function factValue(facts: Facts, field: ConditionField): unknown {
  switch (field) {
    case "affiliateTag":
      return facts.affiliateTags;
    case "affiliateGroup":
      return facts.affiliateGroups;
    default:
      return facts[field];
  }
}

export function conditionMatches(c: Condition, facts: Facts): boolean {
  const actual = factValue(facts, c.field);
  const list = Array.isArray(c.value) ? c.value : [c.value];
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
  if (c.field === "affiliateTag" || c.field === "affiliateGroup") {
    const tags = (actual as string[]).map((t) => t.toLowerCase());
    const has = list.some((v) => tags.includes(String(norm(v))));
    return c.op === "neq" || c.op === "not_in" ? !has : has;
  }
  if (actual === null || actual === undefined) return c.op === "neq" || c.op === "not_in";
  switch (c.op) {
    case "eq":
      return norm(actual) === norm(list[0]);
    case "neq":
      return norm(actual) !== norm(list[0]);
    case "in":
      return list.some((v) => norm(v) === norm(actual));
    case "not_in":
      return !list.some((v) => norm(v) === norm(actual));
    case "gte":
      return Number(actual) >= Number(list[0]);
    case "lte":
      return Number(actual) <= Number(list[0]);
  }
}

export function ruleMatches(conditions: Condition[], facts: Facts): boolean {
  return conditions.every((c) => conditionMatches(c, facts));
}

export interface RuleDeps {
  email: messaging.EmailProvider;
  webUrl: string;
}

interface ActionResult {
  type: Action["type"];
  ok: boolean;
  detail?: string;
  error?: string;
}

async function executeAction(db: DbLike, ctx: TenantContext, rule: AutomationRule, action: Action, facts: Facts, event: DomainEvent, deps: RuleDeps): Promise<ActionResult> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
  const vars = {
    affiliate_name: facts.affiliateName ?? "",
    business_name: tenant?.name ?? "",
    program_name: facts.programName ?? "",
    offer_name: facts.offerName ?? "",
    campaign_name: facts.campaignName ?? "",
    amount: facts.amountMinor != null ? (facts.amountMinor / 100).toFixed(2) : "",
    currency: facts.currency ?? tenant?.currency ?? "",
    portal_url: `${deps.webUrl}/portal`,
    link: `${deps.webUrl}/portal`,
    reason: (event.data.reason as string | undefined) ?? "",
  } satisfies Partial<Record<messaging.TemplateVariable, string | number>>;
  const needAffiliate = () => {
    if (!facts.affiliateId) throw validation("no affiliate in this event");
    return facts.affiliateId;
  };
  switch (action.type) {
    case "send_template": {
      if (!facts.affiliateEmail) throw validation("no affiliate email in this event");
      const log = await messaging.sendTemplated(db, ctx, deps.email, { key: action.templateKey, to: facts.affiliateEmail, vars, affiliateId: facts.affiliateId, related: { type: event.entityType, id: event.entityId } });
      return { type: action.type, ok: log.status === "sent", detail: `${action.templateKey} → ${facts.affiliateEmail} (${log.status})`, error: log.error ?? undefined };
    }
    case "send_custom": {
      if (!facts.affiliateEmail) throw validation("no affiliate email in this event");
      const log = await messaging.sendCustom(db, ctx, deps.email, { to: facts.affiliateEmail, subject: messaging.renderTemplate(action.subject, vars), body: messaging.renderTemplate(action.body, vars), affiliateId: facts.affiliateId, related: { type: event.entityType, id: event.entityId } });
      return { type: action.type, ok: log.status === "sent", detail: `custom → ${facts.affiliateEmail} (${log.status})`, error: log.error ?? undefined };
    }
    case "approve_commission": {
      if (!facts.commissionId) throw validation("no commission in this event");
      const c = await commissionsSvc.approveCommission(db, ctx, facts.commissionId, `automation: ${rule.name}`);
      return { type: action.type, ok: true, detail: `commission ${c.id} → ${c.status}` };
    }
    case "approve_conversion": {
      if (!facts.conversionId) throw validation("no conversion in this event");
      const c = await conversionsSvc.approveConversion(db, ctx, facts.conversionId);
      return { type: action.type, ok: true, detail: `conversion ${c.id} → ${c.status}` };
    }
    case "add_tag":
    case "remove_tag": {
      const id = needAffiliate();
      const tags = new Set(facts.affiliateTags);
      if (action.type === "add_tag") tags.add(action.tag);
      else tags.delete(action.tag);
      await affiliatesSvc.updateAffiliate(db, ctx, id, { tags: [...tags] });
      facts.affiliateTags = [...tags];
      return { type: action.type, ok: true, detail: `${action.type === "add_tag" ? "+" : "-"}${action.tag}` };
    }
    case "adjust_balance": {
      const id = needAffiliate();
      const entry = await commissionsSvc.adjustAffiliateBalance(db, ctx, { affiliateId: id, amountMinor: action.amountMinor, currency: facts.currency ?? tenant?.currency ?? "USD", reason: `automation: ${rule.name}: ${action.reason}` });
      return { type: action.type, ok: true, detail: `ledger ${entry.id} ${action.amountMinor}` };
    }
    case "create_task": {
      const t = await createTask(db, ctx, { title: messaging.renderTemplate(action.title, vars), note: action.note ? messaging.renderTemplate(action.note, vars) : null, entityType: event.entityType, entityId: event.entityId, affiliateId: facts.affiliateId, ruleId: rule.id });
      return { type: action.type, ok: true, detail: `task ${t.id}` };
    }
    case "suspend_affiliate": {
      const id = needAffiliate();
      await affiliatesSvc.suspendAffiliate(db, ctx, id, `automation: ${rule.name}: ${action.reason}`);
      facts.affiliateStatus = "suspended";
      return { type: action.type, ok: true, detail: `affiliate ${id} suspended` };
    }
  }
}

/**
 * Evaluate every enabled rule for this event. Returns the run records written. Safe to call for
 * any event; rules only exist for the triggers in TRIGGERS. Events caused by automation itself
 * are ignored so a rule can never feed itself.
 */
export async function runRulesForEvent(db: DbLike, ctx: TenantContext, event: DomainEvent, deps: RuleDeps): Promise<AutomationRun[]> {
  if (event.actor?.id === AUTOMATION_ACTOR) return [];
  const rules = await db.select().from(automationRules).where(and(eq(automationRules.tenantId, ctx.tenantId), eq(automationRules.trigger, event.type), eq(automationRules.enabled, true)));
  if (!rules.length) return [];
  const facts = await buildFacts(db, ctx, event);
  const actCtx = tenantContext(ctx.tenantId, { type: "system", id: AUTOMATION_ACTOR, role: "owner" }, ctx.now);
  const runs: AutomationRun[] = [];

  for (const rule of rules) {
    const conditions = z.array(conditionSchema).parse(rule.conditions);
    const actions = z.array(actionSchema).parse(rule.actions);
    const stop = stopSchema.parse(rule.stopConditions[0] ?? {});
    const now = ctx.now();
    const base = { id: newId("automationRun"), tenantId: ctx.tenantId, ruleId: rule.id, trigger: event.type, eventPayload: event as unknown as Record<string, unknown>, entityType: event.entityType, entityId: event.entityId, affiliateId: facts.affiliateId, createdAt: now };
    const skip = async (reason: string, matched = false) => {
      const [row] = await db.insert(automationRuns).values({ ...base, matched, actionsTaken: [], status: "skipped", error: reason }).returning();
      runs.push(row!);
    };

    if (facts.affiliateStatus && stop.skipIfAffiliateStatusIn.includes(facts.affiliateStatus)) {
      await skip(`affiliate is ${facts.affiliateStatus}`);
      continue;
    }
    if (stop.activeFrom && now < stop.activeFrom) {
      await skip("before active window");
      continue;
    }
    if (stop.activeUntil && now > stop.activeUntil) {
      await skip("after active window");
      continue;
    }
    if (stop.oncePerEntity) {
      const prior = await db.query.automationRuns.findFirst({ where: and(eq(automationRuns.ruleId, rule.id), eq(automationRuns.entityType, event.entityType), eq(automationRuns.entityId, event.entityId), eq(automationRuns.status, "success")) });
      if (prior) {
        await skip("already ran for this entity");
        continue;
      }
    }
    if (stop.oncePerAffiliate && facts.affiliateId) {
      const prior = await db.query.automationRuns.findFirst({ where: and(eq(automationRuns.ruleId, rule.id), eq(automationRuns.affiliateId, facts.affiliateId), eq(automationRuns.status, "success")) });
      if (prior) {
        await skip("already ran for this affiliate");
        continue;
      }
    }
    if (!ruleMatches(conditions, facts)) {
      await skip("conditions not met");
      continue;
    }

    const taken: ActionResult[] = [];
    let error: string | null = null;
    for (const action of actions) {
      try {
        // Each action gets its own savepoint so a failure cannot poison the enclosing transaction.
        taken.push(await withTx(db, (tx) => executeAction(tx, actCtx, rule, action, facts, event, deps)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        taken.push({ type: action.type, ok: false, error: message });
        error = `${action.type}: ${message}`;
        break;
      }
    }
    const [row] = await db
      .insert(automationRuns)
      .values({ ...base, matched: true, actionsTaken: taken as unknown as Record<string, unknown>[], status: error ? "failed" : "success", error })
      .returning();
    runs.push(row!);
  }
  return runs;
}
