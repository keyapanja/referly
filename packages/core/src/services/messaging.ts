import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { affiliates, messageLogs, messageTemplates, tenants, type Affiliate, type MessageLog, type MessageTemplate } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit } from "./audit";
import type { TextChannel, TextProvider } from "./textProviders";

/**
 * MSG-01..07. Templates are plain text with {{variable}} placeholders. Only variables from the
 * allow-list below are substituted; anything else renders empty. No generative AI here: tone
 * only selects which default template is seeded (MSG-03).
 *
 * Two template channels: `email` (subject + body) and `text` (short body shared by SMS and
 * WhatsApp). Email is always sent; a text goes out in addition when the affiliate opted in to a
 * text channel and the workspace has a text provider (Phase 2 WhatsApp/SMS).
 */
export const TEMPLATE_VARIABLES = [
  "affiliate_name",
  "business_name",
  "program_name",
  "offer_name",
  "amount",
  "currency",
  "link",
  "code",
  "payout_date",
  "portal_url",
  "reason",
  "campaign_name",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export const TEMPLATE_KEYS = [
  "affiliate_invite",
  "affiliate_applied",
  "affiliate_approved",
  "affiliate_rejected",
  "conversion_recorded",
  "commission_approved",
  "commission_reversed",
  "payout_paid",
  "campaign_launched",
  "policy_updated",
  "verify_email",
  "password_reset",
  "dispute_update",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_CHANNELS = ["email", "text"] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

/** Account emails carry links that must never go over a text channel. */
const TEXT_TEMPLATE_KEYS: TemplateKey[] = ["affiliate_invite", "affiliate_approved", "affiliate_rejected", "conversion_recorded", "commission_approved", "commission_reversed", "payout_paid", "campaign_launched", "policy_updated", "dispute_update"];

type Tone = "friendly" | "professional" | "concise" | "warm" | "formal";

const GREETING: Record<Tone, string> = {
  friendly: "Hi {{affiliate_name}},",
  professional: "Dear {{affiliate_name}},",
  concise: "{{affiliate_name}},",
  warm: "Hello {{affiliate_name}}, lovely to have you with us.",
  formal: "Dear {{affiliate_name}},",
};
const SIGNOFF: Record<Tone, string> = {
  friendly: "Thanks,\n{{business_name}}",
  professional: "Kind regards,\n{{business_name}}",
  concise: "{{business_name}}",
  warm: "With thanks,\n{{business_name}}",
  formal: "Yours sincerely,\n{{business_name}}",
};
const TEXT_GREETING: Record<Tone, string> = {
  friendly: "Hi {{affiliate_name}}, ",
  professional: "Hello {{affiliate_name}}, ",
  concise: "",
  warm: "Hello {{affiliate_name}}, ",
  formal: "Dear {{affiliate_name}}, ",
};

export function defaultTemplates(tone: Tone): Array<{ key: TemplateKey; subject: string; body: string }> {
  const g = GREETING[tone];
  const s = SIGNOFF[tone];
  return [
    { key: "affiliate_invite", subject: "You're invited to join {{program_name}}", body: `${g}\n\n{{business_name}} has invited you to promote {{program_name}}. Accept your invitation here: {{link}}\n\n${s}` },
    { key: "affiliate_applied", subject: "We received your application to {{program_name}}", body: `${g}\n\nThanks for applying to {{program_name}}. We will review it and let you know.\n\n${s}` },
    { key: "affiliate_approved", subject: "You're approved for {{program_name}}", body: `${g}\n\nYou're approved to promote {{program_name}}. Sign in to your portal to get your links: {{portal_url}}\n\n${s}` },
    { key: "affiliate_rejected", subject: "Update on your application to {{program_name}}", body: `${g}\n\nWe are not able to approve your application to {{program_name}} at this time.\n\n${s}` },
    { key: "conversion_recorded", subject: "New sale attributed to you", body: `${g}\n\nA sale of {{amount}} {{currency}} for {{offer_name}} was attributed to you. Commission is pending until the holding period ends.\n\n${s}` },
    { key: "commission_approved", subject: "Commission approved", body: `${g}\n\nYour commission of {{amount}} {{currency}} has been approved.\n\n${s}` },
    { key: "commission_reversed", subject: "Commission adjusted", body: `${g}\n\nA commission of {{amount}} {{currency}} was reversed. Reason: {{reason}}\n\n${s}` },
    { key: "payout_paid", subject: "Payout sent", body: `${g}\n\nWe sent your payout of {{amount}} {{currency}} on {{payout_date}}.\n\n${s}` },
    { key: "campaign_launched", subject: "You're invited: {{campaign_name}}", body: `${g}\n\n{{business_name}} has invited you to the {{campaign_name}} campaign for {{program_name}}. Join it in your portal to get the campaign rate, bonus and creative: {{portal_url}}\n\n${s}` },
    { key: "policy_updated", subject: "{{program_name}} terms updated", body: `${g}\n\nThe terms for {{program_name}} have changed. Please review and accept them in your portal: {{portal_url}}\n\n${s}` },
    { key: "verify_email", subject: "Verify your email for {{business_name}}", body: `${g}\n\nConfirm your email address to finish setting up {{business_name}}: {{link}}\n\nThis link expires in 24 hours.\n\n${s}` },
    { key: "dispute_update", subject: "Update on your dispute with {{business_name}}", body: `${g}\n\n{{reason}}\n\nYou can reply in your portal: {{portal_url}}\n\n${s}` },
    { key: "password_reset", subject: "Reset your password", body: `${g}\n\nWe received a request to reset the password for your {{business_name}} account. Choose a new password here: {{link}}\n\nIf you did not ask for this, you can ignore this email. The link expires in 1 hour.\n\n${s}` },
  ];
}

/** Short bodies for SMS/WhatsApp (subject is the log label only; it is never sent). */
export function defaultTextTemplates(tone: Tone): Array<{ key: TemplateKey; subject: string; body: string }> {
  const g = TEXT_GREETING[tone];
  return [
    { key: "affiliate_invite", subject: "Invitation", body: `${g}{{business_name}} invited you to promote {{program_name}}. Accept here: {{link}}` },
    { key: "affiliate_approved", subject: "Approved", body: `${g}you're approved for {{program_name}}. Get your links: {{portal_url}}` },
    { key: "affiliate_rejected", subject: "Application update", body: `${g}we couldn't approve your application to {{program_name}} this time. — {{business_name}}` },
    { key: "conversion_recorded", subject: "New sale", body: `${g}a sale of {{amount}} {{currency}} for {{offer_name}} was attributed to you. — {{business_name}}` },
    { key: "commission_approved", subject: "Commission approved", body: `${g}your commission of {{amount}} {{currency}} is approved. — {{business_name}}` },
    { key: "commission_reversed", subject: "Commission adjusted", body: `${g}a commission of {{amount}} {{currency}} was reversed: {{reason}}. — {{business_name}}` },
    { key: "payout_paid", subject: "Payout sent", body: `${g}we sent your payout of {{amount}} {{currency}} on {{payout_date}}. — {{business_name}}` },
    { key: "campaign_launched", subject: "Campaign invite", body: `${g}you're invited to the {{campaign_name}} campaign for {{program_name}}. Join in your portal: {{portal_url}}` },
    { key: "policy_updated", subject: "Terms updated", body: `${g}the terms for {{program_name}} changed. Review them: {{portal_url}}` },
    { key: "dispute_update", subject: "Dispute update", body: `${g}{{reason}} Reply in your portal: {{portal_url}}` },
  ];
}

function defaultsFor(channel: TemplateChannel, tone: Tone) {
  return channel === "text" ? defaultTextTemplates(tone) : defaultTemplates(tone);
}

export async function seedDefaultTemplates(db: DbLike, ctx: TenantContext, tone: Tone = "friendly"): Promise<void> {
  const rows = TEMPLATE_CHANNELS.flatMap((channel) =>
    defaultsFor(channel, tone).map((t) => ({
      id: newId("messageTemplate"),
      tenantId: ctx.tenantId,
      key: t.key,
      channel,
      tone,
      subject: t.subject,
      body: t.body,
      enabled: true,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })),
  );
  await db.insert(messageTemplates).values(rows).onConflictDoNothing();
}

const VARIABLE_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function renderTemplate(text: string, vars: Partial<Record<TemplateVariable, string | number>>): string {
  return text.replace(VARIABLE_RE, (_m, name: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) return "";
    const v = vars[name as TemplateVariable];
    return v === undefined || v === null ? "" : String(v);
  });
}

export function validateTemplateText(text: string): void {
  for (const m of text.matchAll(VARIABLE_RE)) {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(m[1]!)) throw validation(`unknown template variable {{${m[1]}}}`, { allowed: TEMPLATE_VARIABLES });
  }
}

export const updateTemplateSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000).optional(),
  enabled: z.boolean().optional(),
});

export const TEXT_BODY_MAX = 1000;

export async function updateTemplate(db: DbLike, ctx: TenantContext, key: TemplateKey, rawInput: z.input<typeof updateTemplateSchema>, channel: TemplateChannel = "email"): Promise<MessageTemplate> {
  requirePerm(ctx, "messages.write");
  const input = updateTemplateSchema.parse(rawInput);
  if (input.subject) validateTemplateText(input.subject);
  if (input.body) validateTemplateText(input.body);
  if (channel === "text" && input.body && input.body.length > TEXT_BODY_MAX) throw validation(`text templates are limited to ${TEXT_BODY_MAX} characters`);
  const [row] = await db
    .update(messageTemplates)
    .set({ ...input, updatedAt: ctx.now() })
    .where(and(eq(messageTemplates.tenantId, ctx.tenantId), eq(messageTemplates.key, key), eq(messageTemplates.channel, channel)))
    .returning();
  if (!row) throw notFound("template", key);
  await writeAudit(db, ctx, { entityType: "message_template", entityId: row.id, action: "updated", after: { channel, ...input } });
  return row;
}

export async function getTemplate(db: DbLike, ctx: TenantContext, key: TemplateKey, channel: TemplateChannel = "email"): Promise<MessageTemplate | null> {
  return (
    (await db.query.messageTemplates.findFirst({
      where: and(eq(messageTemplates.tenantId, ctx.tenantId), eq(messageTemplates.key, key), eq(messageTemplates.channel, channel)),
    })) ?? null
  );
}

/** Lists templates, back-filling text templates for workspaces created before the channel existed. */
export async function listTemplates(db: DbLike, ctx: TenantContext): Promise<MessageTemplate[]> {
  requirePerm(ctx, "read");
  const rows = await db.select().from(messageTemplates).where(eq(messageTemplates.tenantId, ctx.tenantId));
  if (!rows.some((r) => r.channel === "text") && ctx.actor.type !== "affiliate") {
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
    await seedDefaultTemplates(db, ctx, (tenant?.tone as Tone | undefined) ?? "friendly");
    return db.select().from(messageTemplates).where(eq(messageTemplates.tenantId, ctx.tenantId));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Delivery (MSG-04, MSG-07)
// ---------------------------------------------------------------------------

export interface OutboundMessage {
  to: string;
  subject: string;
  body: string;
}

/** Provider adapter. The API wires a real provider; tests and dev use the in-memory one. */
export interface EmailProvider {
  send(message: OutboundMessage): Promise<{ providerMessageId?: string }>;
}

export class MemoryEmailProvider implements EmailProvider {
  readonly sent: OutboundMessage[] = [];
  async send(message: OutboundMessage) {
    this.sent.push(message);
    return { providerMessageId: `mem_${this.sent.length}` };
  }
}

export class ConsoleEmailProvider implements EmailProvider {
  async send(message: OutboundMessage) {
    console.log(`[email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.body}\n`);
    return {};
  }
}

export interface SendTemplatedInput {
  key: TemplateKey;
  to: string;
  vars: Partial<Record<TemplateVariable, string | number>>;
  affiliateId?: string | null;
  related?: { type: string; id: string };
}

async function resolveTemplate(db: DbLike, ctx: TenantContext, key: TemplateKey, channel: TemplateChannel): Promise<MessageTemplate | null> {
  const template = await getTemplate(db, ctx, key, channel);
  if (template) return template;
  // Tenants created before a template existed fall back to the platform default for their tone.
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
  const tone = (tenant?.tone as Tone | undefined) ?? "friendly";
  const fallback = defaultsFor(channel, tone).find((t) => t.key === key);
  if (!fallback) return null;
  return { id: "default", tenantId: ctx.tenantId, key, channel, tone, subject: fallback.subject, body: fallback.body, enabled: true, createdAt: ctx.now(), updatedAt: ctx.now() };
}

/** Render a tenant template and send it by email, logging the outcome regardless of success. */
export async function sendTemplated(db: DbLike, ctx: TenantContext, provider: EmailProvider, input: SendTemplatedInput): Promise<MessageLog> {
  const template = await resolveTemplate(db, ctx, input.key, "email");
  const base = {
    id: newId("messageLog"),
    tenantId: ctx.tenantId,
    templateKey: input.key,
    channel: "email",
    recipient: input.to,
    affiliateId: input.affiliateId ?? null,
    relatedEntityType: input.related?.type ?? null,
    relatedEntityId: input.related?.id ?? null,
    createdAt: ctx.now(),
  };
  if (!template || !template.enabled) {
    const [row] = await db.insert(messageLogs).values({ ...base, status: "skipped", error: template ? "template disabled" : "template missing" }).returning();
    return row!;
  }
  const subject = renderTemplate(template.subject, input.vars);
  const body = renderTemplate(template.body, input.vars);
  try {
    const result = await provider.send({ to: input.to, subject, body });
    const [row] = await db
      .insert(messageLogs)
      .values({ ...base, subject, body, status: "sent", providerMessageId: result.providerMessageId ?? null, sentAt: ctx.now() })
      .returning();
    return row!;
  } catch (err) {
    const [row] = await db
      .insert(messageLogs)
      .values({ ...base, subject, body, status: "failed", error: err instanceof Error ? err.message : String(err) })
      .returning();
    return row!;
  }
}

/** Send a one-off (non-template) message, logged like every other send. Used by automation rules. */
export async function sendCustom(db: DbLike, ctx: TenantContext, provider: EmailProvider, input: { to: string; subject: string; body: string; affiliateId?: string | null; related?: { type: string; id: string } }): Promise<MessageLog> {
  const base = {
    id: newId("messageLog"),
    tenantId: ctx.tenantId,
    templateKey: "custom",
    channel: "email",
    recipient: input.to,
    subject: input.subject,
    body: input.body,
    affiliateId: input.affiliateId ?? null,
    relatedEntityType: input.related?.type ?? null,
    relatedEntityId: input.related?.id ?? null,
    createdAt: ctx.now(),
  };
  try {
    const result = await provider.send({ to: input.to, subject: input.subject, body: input.body });
    const [row] = await db.insert(messageLogs).values({ ...base, status: "sent", providerMessageId: result.providerMessageId ?? null, sentAt: ctx.now() }).returning();
    return row!;
  } catch (err) {
    const [row] = await db.insert(messageLogs).values({ ...base, status: "failed", error: err instanceof Error ? err.message : String(err) }).returning();
    return row!;
  }
}

// ---------------------------------------------------------------------------
// Text channel (SMS / WhatsApp)
// ---------------------------------------------------------------------------

/** Everything a send needs to reach the affiliate on more than one channel. */
export interface Transports {
  email: EmailProvider;
  /** Resolved per tenant; null when the workspace has no text provider. */
  text?: TextProvider | null;
  /** Absolute URL Twilio (etc.) should call with delivery status for this tenant. */
  textStatusUrl?: string;
}

/** Whether an affiliate may currently be texted, and on which channel. */
export function textEligibility(affiliate: Pick<Affiliate, "phone" | "textChannel" | "textConsentAt" | "textOptOutAt">, provider: TextProvider | null | undefined): { ok: true; channel: TextChannel; to: string } | { ok: false; reason: string } {
  const channel = affiliate.textChannel as TextChannel | null;
  if (!channel) return { ok: false, reason: "affiliate has not opted in to text messages" };
  if (!affiliate.textConsentAt || (affiliate.textOptOutAt && affiliate.textOptOutAt >= affiliate.textConsentAt)) return { ok: false, reason: "affiliate opted out of text messages" };
  if (!affiliate.phone) return { ok: false, reason: "affiliate has no phone number" };
  if (!provider) return { ok: false, reason: "no text provider connected" };
  if (!provider.channels().includes(channel)) return { ok: false, reason: `text provider has no ${channel} sender` };
  return { ok: true, channel, to: affiliate.phone };
}

async function sendText(db: DbLike, ctx: TenantContext, transports: Transports, input: { templateKey: string; body: string; subject?: string | null; affiliate: Affiliate; related?: { type: string; id: string } }): Promise<MessageLog | null> {
  const eligibility = textEligibility(input.affiliate, transports.text);
  const base = {
    id: newId("messageLog"),
    tenantId: ctx.tenantId,
    templateKey: input.templateKey,
    recipient: input.affiliate.phone ?? "",
    subject: input.subject ?? null,
    body: input.body,
    affiliateId: input.affiliate.id,
    relatedEntityType: input.related?.type ?? null,
    relatedEntityId: input.related?.id ?? null,
    createdAt: ctx.now(),
  };
  if (!eligibility.ok) {
    // Only log a skip when the affiliate asked for texts; otherwise there is nothing to explain.
    if (!input.affiliate.textChannel) return null;
    const [row] = await db.insert(messageLogs).values({ ...base, channel: input.affiliate.textChannel, status: "skipped", error: eligibility.reason }).returning();
    return row!;
  }
  try {
    const result = await transports.text!.send({ to: eligibility.to, channel: eligibility.channel, body: input.body, statusCallbackUrl: transports.textStatusUrl });
    const [row] = await db.insert(messageLogs).values({ ...base, channel: eligibility.channel, recipient: eligibility.to, status: "sent", providerMessageId: result.providerMessageId ?? null, sentAt: ctx.now() }).returning();
    return row!;
  } catch (err) {
    const [row] = await db.insert(messageLogs).values({ ...base, channel: eligibility.channel, recipient: eligibility.to, status: "failed", error: err instanceof Error ? err.message : String(err) }).returning();
    return row!;
  }
}

/** Render the text template for an event and send it if the affiliate opted in. */
export async function sendTemplatedText(db: DbLike, ctx: TenantContext, transports: Transports, input: SendTemplatedInput & { affiliate: Affiliate }): Promise<MessageLog | null> {
  if (!TEXT_TEMPLATE_KEYS.includes(input.key)) return null;
  if (!input.affiliate.textChannel) return null;
  const template = await resolveTemplate(db, ctx, input.key, "text");
  if (!template || !template.enabled) {
    const [row] = await db
      .insert(messageLogs)
      .values({ id: newId("messageLog"), tenantId: ctx.tenantId, templateKey: input.key, channel: input.affiliate.textChannel, recipient: input.affiliate.phone ?? "", affiliateId: input.affiliate.id, relatedEntityType: input.related?.type ?? null, relatedEntityId: input.related?.id ?? null, status: "skipped", error: template ? "text template disabled" : "text template missing", createdAt: ctx.now() })
      .returning();
    return row!;
  }
  return sendText(db, ctx, transports, { templateKey: input.key, subject: template.subject, body: renderTemplate(template.body, input.vars), affiliate: input.affiliate, related: input.related });
}

/** One-off text (automation "send_text"). Always logs, so a skipped send is explainable. */
export async function sendCustomText(db: DbLike, ctx: TenantContext, transports: Transports, input: { affiliateId: string; body: string; related?: { type: string; id: string } }): Promise<MessageLog> {
  const affiliate = await db.query.affiliates.findFirst({ where: and(eq(affiliates.id, input.affiliateId), eq(affiliates.tenantId, ctx.tenantId)) });
  if (!affiliate) throw notFound("affiliate", input.affiliateId);
  const log = await sendText(db, ctx, transports, { templateKey: "custom", body: input.body, affiliate: { ...affiliate, textChannel: affiliate.textChannel ?? "sms" }, related: input.related });
  return log!;
}

/**
 * Notification fan-out for an affiliate-facing event: the email template always, plus the text
 * template when the affiliate opted in. Returns every log written.
 */
export async function sendNotification(db: DbLike, ctx: TenantContext, transports: Transports, input: SendTemplatedInput & { affiliate?: Affiliate | null }): Promise<MessageLog[]> {
  const logs: MessageLog[] = [await sendTemplated(db, ctx, transports.email, input)];
  if (input.affiliate) {
    const text = await sendTemplatedText(db, ctx, transports, { ...input, affiliate: input.affiliate });
    if (text) logs.push(text);
  }
  return logs;
}

/** Provider status callback (Twilio MessageStatus). Terminal states only; earlier ones are noise. */
export async function recordDeliveryStatus(db: DbLike, ctx: TenantContext, providerMessageId: string, status: "delivered" | "undelivered" | "failed", error?: string): Promise<MessageLog | null> {
  const [row] = await db
    .update(messageLogs)
    .set({ status, error: error ?? null, deliveredAt: status === "delivered" ? ctx.now() : null })
    .where(and(eq(messageLogs.tenantId, ctx.tenantId), eq(messageLogs.providerMessageId, providerMessageId)))
    .returning();
  return row ?? null;
}

export async function listMessageLogs(db: DbLike, ctx: TenantContext, filter: { affiliateId?: string; channel?: string; limit?: number } = {}): Promise<MessageLog[]> {
  requirePerm(ctx, "read");
  return db
    .select()
    .from(messageLogs)
    .where(and(eq(messageLogs.tenantId, ctx.tenantId), filter.affiliateId ? eq(messageLogs.affiliateId, filter.affiliateId) : undefined, filter.channel ? eq(messageLogs.channel, filter.channel) : undefined))
    .orderBy(desc(messageLogs.createdAt))
    .limit(filter.limit ?? 100);
}
