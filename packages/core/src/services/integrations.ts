import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { affiliates, payouts, tenantIntegrations, type Payout, type TenantIntegration } from "../db/schema";
import { newId } from "../ids";
import { conflict, notFound, validation } from "../errors";
import { type TenantContext, require as requirePerm, requireAffiliate } from "../context";
import { decryptJson, encryptJson } from "../crypto";
import { writeAudit } from "./audit";
import { enqueueJob } from "./jobs";
import { getAffiliate, setPayoutProfile } from "./affiliates";
import { getPayout, markPayoutFailed, markPayoutPaid, listPayouts } from "./payouts";
import { PAYOUT_PROVIDER_IDS, PROVIDER_FOR_METHOD, createPayoutProvider, type PayoutProvider, type PayoutProviderFactory, type PayoutProviderId, type ProviderCredentials, type ProviderOptions } from "./payoutProviders";
import { TEXT_PROVIDER_IDS, createTextProvider, E164_RE, type TextCredentials, type TextProvider, type TextProviderFactory, type TextProviderId, type TextProviderOptions } from "./textProviders";

/**
 * Tenant integrations: per-merchant payout provider credentials, stored encrypted, and the
 * provider-driven payout flow (queue → send in the worker → poll until settled). The manual
 * payout path (PAY-07) is untouched; providers are an addition.
 */

export const credentialsSchema = {
  stripe_connect: z.object({ secretKey: z.string().regex(/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/, "expected a Stripe secret key") }),
  paypal: z.object({ clientId: z.string().min(10), clientSecret: z.string().min(10), sandbox: z.boolean().default(false) }),
  twilio: z
    .object({
      accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/, "expected a Twilio account SID (AC…)"),
      authToken: z.string().min(16),
      fromSms: z.string().regex(/^(\+[1-9]\d{6,14}|MG[0-9a-fA-F]{32})$/, "expected an E.164 number or a Messaging Service SID").optional(),
      fromWhatsApp: z.string().regex(E164_RE, "expected an E.164 number").optional(),
    })
    .refine((c) => c.fromSms || c.fromWhatsApp, { message: "add an SMS sender, a WhatsApp sender, or both" }),
} as const;

export type IntegrationProviderId = PayoutProviderId | TextProviderId;

export interface IntegrationDeps {
  factory?: PayoutProviderFactory;
  providerOptions?: ProviderOptions;
}

/** Text (SMS/WhatsApp) provider construction; the API sets a console fallback in development. */
export interface TextDeps {
  factory?: TextProviderFactory;
  providerOptions?: TextProviderOptions;
  /** Used when the tenant has no provider of its own (dev console, or a platform-wide account). */
  fallback?: TextProvider | null;
}

function hint(provider: IntegrationProviderId, creds: ProviderCredentials | TextCredentials): string {
  if (provider === "twilio") {
    const t = creds as TextCredentials;
    return `${t.accountSid.slice(0, 6)}… · ${[t.fromSms && `SMS ${t.fromSms}`, t.fromWhatsApp && `WhatsApp ${t.fromWhatsApp}`].filter(Boolean).join(", ")}`;
  }
  if (provider === "stripe_connect") {
    const k = (creds as { secretKey: string }).secretKey;
    return `${k.slice(0, 8)}…${k.slice(-4)}`;
  }
  const p = creds as { clientId: string; sandbox?: boolean };
  return `client …${p.clientId.slice(-4)}${p.sandbox ? " (sandbox)" : ""}`;
}

export function publicIntegration(row: TenantIntegration) {
  return { provider: row.provider as IntegrationProviderId, status: row.status, hint: row.hint, connectedAt: row.createdAt, lastVerifiedAt: row.lastVerifiedAt };
}

export async function connectPayoutProvider(db: DbLike, ctx: TenantContext, provider: PayoutProviderId, rawCredentials: unknown, deps: IntegrationDeps = {}): Promise<TenantIntegration> {
  requirePerm(ctx, "integrations.manage");
  if (!PAYOUT_PROVIDER_IDS.includes(provider)) throw validation(`unknown provider ${provider}`);
  const creds = credentialsSchema[provider].parse(rawCredentials) as ProviderCredentials;
  const adapter = (deps.factory ?? createPayoutProvider)(provider, creds, deps.providerOptions);
  const check = await adapter.verifyCredentials();
  if (!check.ok) throw validation(`could not verify ${adapter.label} credentials: ${check.detail ?? "unknown error"}`);
  const values = { tenantId: ctx.tenantId, provider, credentialsEnc: encryptJson(creds), hint: hint(provider, creds), status: "connected", lastVerifiedAt: ctx.now(), updatedAt: ctx.now() };
  const existing = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider)) });
  const [row] = existing
    ? await db.update(tenantIntegrations).set(values).where(eq(tenantIntegrations.id, existing.id)).returning()
    : await db.insert(tenantIntegrations).values({ id: newId("integration"), ...values, createdAt: ctx.now() }).returning();
  await writeAudit(db, ctx, { entityType: "integration", entityId: row!.id, action: existing ? "reconnected" : "connected", after: { provider, hint: row!.hint } });
  return row!;
}

export async function disconnectPayoutProvider(db: DbLike, ctx: TenantContext, provider: PayoutProviderId): Promise<void> {
  requirePerm(ctx, "integrations.manage");
  const existing = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider)) });
  if (!existing) throw notFound("integration", provider);
  const inFlight = await db.query.payouts.findFirst({ where: and(eq(payouts.tenantId, ctx.tenantId), eq(payouts.provider, provider), eq(payouts.status, "processing")) });
  if (inFlight) throw conflict("payouts are still processing through this provider; wait for them to settle");
  await db.delete(tenantIntegrations).where(eq(tenantIntegrations.id, existing.id));
  await writeAudit(db, ctx, { entityType: "integration", entityId: existing.id, action: "disconnected", before: { provider } });
}

export async function listIntegrations(db: DbLike, ctx: TenantContext) {
  requirePerm(ctx, "read");
  const rows = await db.select().from(tenantIntegrations).where(eq(tenantIntegrations.tenantId, ctx.tenantId));
  return rows.map(publicIntegration);
}

/** Connected payout provider ids, for both merchant and affiliate views. */
export async function connectedProviders(db: DbLike, ctx: TenantContext): Promise<PayoutProviderId[]> {
  const rows = await db.select({ provider: tenantIntegrations.provider }).from(tenantIntegrations).where(and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.status, "connected")));
  return rows.map((r) => r.provider as PayoutProviderId).filter((p) => PAYOUT_PROVIDER_IDS.includes(p));
}

// ---------------------------------------------------------------------------
// Text providers (SMS / WhatsApp)
// ---------------------------------------------------------------------------

export async function connectTextProvider(db: DbLike, ctx: TenantContext, provider: TextProviderId, rawCredentials: unknown, deps: TextDeps = {}): Promise<TenantIntegration> {
  requirePerm(ctx, "integrations.manage");
  if (!TEXT_PROVIDER_IDS.includes(provider)) throw validation(`unknown provider ${provider}`);
  const creds = credentialsSchema[provider].parse(rawCredentials) as TextCredentials;
  const adapter = (deps.factory ?? createTextProvider)(provider, creds, deps.providerOptions);
  const check = await adapter.verifyCredentials();
  if (!check.ok) throw validation(`could not verify ${adapter.label} credentials: ${check.detail ?? "unknown error"}`);
  const values = { tenantId: ctx.tenantId, provider, credentialsEnc: encryptJson(creds), hint: hint(provider, creds), status: "connected", lastVerifiedAt: ctx.now(), updatedAt: ctx.now() };
  const existing = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider)) });
  const [row] = existing
    ? await db.update(tenantIntegrations).set(values).where(eq(tenantIntegrations.id, existing.id)).returning()
    : await db.insert(tenantIntegrations).values({ id: newId("integration"), ...values, createdAt: ctx.now() }).returning();
  await writeAudit(db, ctx, { entityType: "integration", entityId: row!.id, action: existing ? "reconnected" : "connected", after: { provider, hint: row!.hint } });
  return row!;
}

export async function disconnectTextProvider(db: DbLike, ctx: TenantContext, provider: TextProviderId): Promise<void> {
  requirePerm(ctx, "integrations.manage");
  const existing = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider)) });
  if (!existing) throw notFound("integration", provider);
  await db.delete(tenantIntegrations).where(eq(tenantIntegrations.id, existing.id));
  await writeAudit(db, ctx, { entityType: "integration", entityId: existing.id, action: "disconnected", before: { provider } });
}

/** The tenant's text provider, or the platform fallback. Credentials are decrypted only here. */
export async function textProviderFor(db: DbLike, ctx: TenantContext, deps: TextDeps = {}): Promise<TextProvider | null> {
  const row = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, "twilio"), eq(tenantIntegrations.status, "connected")) });
  if (!row) return deps.fallback ?? null;
  return (deps.factory ?? createTextProvider)("twilio", decryptJson<TextCredentials>(row.credentialsEnc), deps.providerOptions);
}

/** Raw Twilio auth token for webhook signature checks; null when Twilio is not connected. */
export async function twilioAuthToken(db: DbLike, ctx: TenantContext): Promise<string | null> {
  const row = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, "twilio"), eq(tenantIntegrations.status, "connected")) });
  return row ? decryptJson<TextCredentials>(row.credentialsEnc).authToken : null;
}

/** Builds the tenant's adapter for a provider. Credentials are decrypted only here. */
export async function providerFor(db: DbLike, ctx: TenantContext, provider: PayoutProviderId, deps: IntegrationDeps = {}): Promise<PayoutProvider | null> {
  const row = await db.query.tenantIntegrations.findFirst({ where: and(eq(tenantIntegrations.tenantId, ctx.tenantId), eq(tenantIntegrations.provider, provider), eq(tenantIntegrations.status, "connected")) });
  if (!row) return null;
  return (deps.factory ?? createPayoutProvider)(provider, decryptJson<ProviderCredentials>(row.credentialsEnc), deps.providerOptions);
}

// ---------------------------------------------------------------------------
// Provider-driven payouts
// ---------------------------------------------------------------------------

/** Marks a draft payout as processing through its affiliate's provider and queues the send. */
export async function queueProviderPayout(db: DbLike, ctx: TenantContext, payoutId: string): Promise<Payout> {
  requirePerm(ctx, "payouts.write");
  const payout = await getPayout(db, ctx, payoutId);
  if (payout.status !== "draft") throw validation(`payout is ${payout.status}`);
  const affiliate = await getAffiliate(db, ctx, payout.affiliateId);
  const provider = affiliate.payoutMethod ? PROVIDER_FOR_METHOD[affiliate.payoutMethod] : undefined;
  if (!provider) throw validation(`affiliate's payout method (${affiliate.payoutMethod ?? "none"}) cannot be paid through a provider`);
  if (!affiliate.payoutProfileRef) throw validation("affiliate has not completed their payout profile");
  const connected = await connectedProviders(db, ctx);
  if (!connected.includes(provider)) throw validation(`${provider} is not connected for this workspace`);
  const [row] = await db
    .update(payouts)
    .set({ status: "processing", provider, method: affiliate.payoutMethod, methodRef: affiliate.payoutProfileRef, idempotencyKey: payout.idempotencyKey ?? `payout:${payout.id}`, providerStatus: "queued", updatedAt: ctx.now() })
    .where(eq(payouts.id, payoutId))
    .returning();
  await writeAudit(db, ctx, { entityType: "payout", entityId: payoutId, action: "status:processing", before: { status: "draft" }, after: { status: "processing", provider } });
  await enqueueJob(db, { tenantId: ctx.tenantId, type: "send_payout", payload: { payoutId, tenantId: ctx.tenantId }, runAt: ctx.now(), maxAttempts: 5, idempotencyKey: `send_payout:${payoutId}` });
  return row!;
}

/** Queues every draft payout whose affiliate can be paid through a connected provider. */
export async function queueAllDraftPayouts(db: DbLike, ctx: TenantContext): Promise<{ queued: Payout[]; skipped: { payoutId: string; reason: string }[] }> {
  requirePerm(ctx, "payouts.write");
  const drafts = await listPayouts(db, ctx, { status: "draft", limit: 1000 });
  const queued: Payout[] = [];
  const skipped: { payoutId: string; reason: string }[] = [];
  for (const d of drafts) {
    try {
      queued.push(await queueProviderPayout(db, ctx, d.id));
    } catch (err) {
      skipped.push({ payoutId: d.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { queued, skipped };
}

/** Worker: performs the provider call for a queued payout. Idempotent per payout. */
export async function executeProviderPayout(db: DbLike, ctx: TenantContext, payoutId: string, deps: IntegrationDeps = {}): Promise<Payout> {
  const payout = await getPayout(db, ctx, payoutId);
  if (payout.status !== "processing" || !payout.provider) return payout;
  if (payout.providerRef) return payout; // already sent; polling will settle it
  const adapter = await providerFor(db, ctx, payout.provider as PayoutProviderId, deps);
  if (!adapter) return markPayoutFailed(db, ctx, payoutId, `${payout.provider} is no longer connected`);
  const affiliate = await getAffiliate(db, ctx, payout.affiliateId);
  const result = await adapter.send({
    payoutId: payout.id,
    affiliateId: payout.affiliateId,
    amountMinor: payout.amountMinor,
    currency: payout.currency,
    destinationRef: payout.methodRef ?? affiliate.payoutProfileRef ?? "",
    idempotencyKey: payout.idempotencyKey ?? `payout:${payout.id}`,
    description: `Affiliate payout ${payout.id}`,
  });
  return applyProviderResult(db, ctx, payout, result);
}

async function applyProviderResult(db: DbLike, ctx: TenantContext, payout: Payout, result: { status: "paid" | "processing" | "failed"; providerRef?: string; providerStatus?: string; error?: string }): Promise<Payout> {
  if (result.status === "paid") {
    await db.update(payouts).set({ providerRef: result.providerRef ?? payout.providerRef, providerStatus: result.providerStatus ?? "paid", updatedAt: ctx.now() }).where(eq(payouts.id, payout.id));
    return markPayoutPaid(db, ctx, payout.id, { externalReference: result.providerRef ?? payout.providerRef ?? undefined });
  }
  if (result.status === "failed") {
    await db.update(payouts).set({ providerRef: result.providerRef ?? payout.providerRef, providerStatus: result.providerStatus ?? "failed", updatedAt: ctx.now() }).where(eq(payouts.id, payout.id));
    return markPayoutFailed(db, ctx, payout.id, result.error ?? "provider reported failure");
  }
  const [row] = await db.update(payouts).set({ providerRef: result.providerRef ?? payout.providerRef, providerStatus: result.providerStatus ?? "processing", updatedAt: ctx.now() }).where(eq(payouts.id, payout.id)).returning();
  return row!;
}

/** Worker: re-checks asynchronous provider payouts that are still processing. */
export async function pollProviderPayouts(db: DbLike, ctx: TenantContext, deps: IntegrationDeps = {}): Promise<number> {
  const pending = await db.select().from(payouts).where(and(eq(payouts.tenantId, ctx.tenantId), eq(payouts.status, "processing"), isNotNull(payouts.provider), isNotNull(payouts.providerRef)));
  let settled = 0;
  const adapters = new Map<string, PayoutProvider | null>();
  for (const p of pending) {
    if (!adapters.has(p.provider!)) adapters.set(p.provider!, await providerFor(db, ctx, p.provider as PayoutProviderId, deps));
    const adapter = adapters.get(p.provider!);
    if (!adapter?.poll) continue;
    const result = await adapter.poll(p.providerRef!);
    if (result.status !== "processing") {
      await applyProviderResult(db, ctx, p, result);
      settled++;
    } else if (result.providerStatus && result.providerStatus !== p.providerStatus) {
      await db.update(payouts).set({ providerStatus: result.providerStatus, updatedAt: ctx.now() }).where(eq(payouts.id, p.id));
    }
  }
  return settled;
}

// ---------------------------------------------------------------------------
// Affiliate onboarding (Stripe Connect Express)
// ---------------------------------------------------------------------------

export async function startStripeOnboarding(db: DbLike, ctx: TenantContext, affiliateId: string, urls: { returnUrl: string; refreshUrl: string }, deps: IntegrationDeps = {}): Promise<{ url: string; accountId: string }> {
  requireAffiliate(ctx, affiliateId);
  const adapter = await providerFor(db, ctx, "stripe_connect", deps);
  if (!adapter?.createOnboardingLink) throw validation("Stripe Connect is not available for this program");
  const affiliate = await getAffiliate(db, ctx, affiliateId);
  const existing = affiliate.payoutMethod === "stripe_connect" ? affiliate.payoutProfileRef : null;
  const link = await adapter.createOnboardingLink({ affiliateId, email: affiliate.email, name: affiliate.name, returnUrl: urls.returnUrl, refreshUrl: urls.refreshUrl, existingAccountId: existing });
  if (link.accountId !== existing) await setPayoutProfile(db, ctx, affiliateId, { method: "stripe_connect", profileRef: link.accountId, masked: `Stripe account …${link.accountId.slice(-4)}` });
  return link;
}

/** Payout methods an affiliate can pick that this tenant can actually pay automatically. */
export async function automatedMethods(db: DbLike, ctx: TenantContext): Promise<string[]> {
  const connected = await connectedProviders(db, ctx);
  return Object.entries(PROVIDER_FOR_METHOD)
    .filter(([, provider]) => connected.includes(provider))
    .map(([method]) => method);
}

export { PROVIDER_FOR_METHOD };
export type { PayoutProviderId };
