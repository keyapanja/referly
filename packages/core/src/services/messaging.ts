import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { messageLogs, messageTemplates, tenants, type MessageLog, type MessageTemplate } from "../db/schema";
import { newId } from "../ids";
import { notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm } from "../context";
import { writeAudit } from "./audit";

/**
 * MSG-01..07. Templates are plain text with {{variable}} placeholders. Only variables from the
 * allow-list below are substituted; anything else renders empty. No generative AI here: tone
 * only selects which default template is seeded (MSG-03).
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
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

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
    { key: "password_reset", subject: "Reset your password", body: `${g}\n\nWe received a request to reset the password for your {{business_name}} account. Choose a new password here: {{link}}\n\nIf you did not ask for this, you can ignore this email. The link expires in 1 hour.\n\n${s}` },
  ];
}

export async function seedDefaultTemplates(db: DbLike, ctx: TenantContext, tone: Tone = "friendly"): Promise<void> {
  const rows = defaultTemplates(tone).map((t) => ({
    id: newId("messageTemplate"),
    tenantId: ctx.tenantId,
    key: t.key,
    channel: "email",
    tone,
    subject: t.subject,
    body: t.body,
    enabled: true,
    createdAt: ctx.now(),
    updatedAt: ctx.now(),
  }));
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

export async function updateTemplate(db: DbLike, ctx: TenantContext, key: TemplateKey, rawInput: z.input<typeof updateTemplateSchema>): Promise<MessageTemplate> {
  requirePerm(ctx, "messages.write");
  const input = updateTemplateSchema.parse(rawInput);
  if (input.subject) validateTemplateText(input.subject);
  if (input.body) validateTemplateText(input.body);
  const [row] = await db
    .update(messageTemplates)
    .set({ ...input, updatedAt: ctx.now() })
    .where(and(eq(messageTemplates.tenantId, ctx.tenantId), eq(messageTemplates.key, key), eq(messageTemplates.channel, "email")))
    .returning();
  if (!row) throw notFound("template", key);
  await writeAudit(db, ctx, { entityType: "message_template", entityId: row.id, action: "updated", after: input });
  return row;
}

export async function getTemplate(db: DbLike, ctx: TenantContext, key: TemplateKey): Promise<MessageTemplate | null> {
  return (
    (await db.query.messageTemplates.findFirst({
      where: and(eq(messageTemplates.tenantId, ctx.tenantId), eq(messageTemplates.key, key), eq(messageTemplates.channel, "email")),
    })) ?? null
  );
}

export async function listTemplates(db: DbLike, ctx: TenantContext): Promise<MessageTemplate[]> {
  requirePerm(ctx, "read");
  return db.select().from(messageTemplates).where(eq(messageTemplates.tenantId, ctx.tenantId));
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

/** Render a tenant template and send it, logging the outcome regardless of success. */
export async function sendTemplated(db: DbLike, ctx: TenantContext, provider: EmailProvider, input: SendTemplatedInput): Promise<MessageLog> {
  let template = await getTemplate(db, ctx, input.key);
  if (!template) {
    // Tenants created before a template existed fall back to the platform default for their tone.
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
    const tone = (tenant?.tone as Tone | undefined) ?? "friendly";
    const fallback = defaultTemplates(tone).find((t) => t.key === input.key);
    if (fallback) template = { id: "default", tenantId: ctx.tenantId, key: input.key, channel: "email", tone, subject: fallback.subject, body: fallback.body, enabled: true, createdAt: ctx.now(), updatedAt: ctx.now() };
  }
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

export async function listMessageLogs(db: DbLike, ctx: TenantContext, filter: { affiliateId?: string; limit?: number } = {}): Promise<MessageLog[]> {
  requirePerm(ctx, "read");
  return db
    .select()
    .from(messageLogs)
    .where(and(eq(messageLogs.tenantId, ctx.tenantId), filter.affiliateId ? eq(messageLogs.affiliateId, filter.affiliateId) : undefined))
    .orderBy(desc(messageLogs.createdAt))
    .limit(filter.limit ?? 100);
}
