import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { tenantContext } from "../src/context";
import * as messaging from "../src/services/messaging";
import * as affiliates from "../src/services/affiliates";
import * as integrations from "../src/services/integrations";
import * as automation from "../src/services/automation";
import { MemoryTextProvider, TwilioTextProvider, normalizePhone, twilioSignature, verifyTwilioSignature } from "../src/services/textProviders";
import { messageLogs, tenants, type Affiliate } from "../src/db/schema";

let db: Db;
const clock = makeClock();
let ws: Workspace;
let alice: Affiliate;

type Captured = { url: string; headers: Record<string, string>; body: string };
function stubFetch(status: number, bodyJson: unknown) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) h[k.toLowerCase()] = v;
    calls.push({ url: String(url), headers: h, body: String(init?.body ?? "") });
    return new Response(JSON.stringify(bodyJson), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
  alice = await createActiveAffiliate(db, ws, "Alice");
  await db.update(tenants).set({ planId: "growth" }).where(eq(tenants.id, ws.tenant.id));
});
afterAll(closeDb);

describe("text messaging (SMS / WhatsApp)", () => {
  const email = new messaging.MemoryEmailProvider();
  const text = new MemoryTextProvider();
  const asAlice = () => tenantContext(ws.tenant.id, { type: "affiliate", id: alice.id, affiliateId: alice.id }, clock.now);

  it("normalises phone numbers to E.164 and rejects everything else", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("whatsapp:+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhone("98765 43210")).toBeNull();
    expect(normalizePhone("+0123")).toBeNull();
  });

  it("seeds a text template set next to the email one", async () => {
    const templates = await messaging.listTemplates(db, ws.ctx);
    const texts = templates.filter((t) => t.channel === "text");
    expect(texts.length).toBeGreaterThanOrEqual(10);
    expect(texts.find((t) => t.key === "payout_paid")!.body).toContain("{{amount}}");
    // account emails never get a text twin
    expect(texts.find((t) => t.key === "password_reset")).toBeUndefined();
    const updated = await messaging.updateTemplate(db, ws.ctx, "payout_paid", { body: "Paid {{amount}} {{currency}} — {{business_name}}" }, "text");
    expect(updated.channel).toBe("text");
    await expect(messaging.updateTemplate(db, ws.ctx, "payout_paid", { body: "x".repeat(1001) }, "text")).rejects.toThrow(/1000/);
    // the email template is untouched
    expect((await messaging.getTemplate(db, ws.ctx, "payout_paid"))!.body).toContain("We sent your payout");
  });

  it("sends email only until the affiliate opts in", async () => {
    const logs = await messaging.sendNotification(db, ws.ctx, { email, text }, { key: "commission_approved", to: alice.email, vars: { amount: "10.00", currency: "USD" }, affiliateId: alice.id, affiliate: alice });
    expect(logs.map((l) => l.channel)).toEqual(["email"]);
    expect(text.sent).toHaveLength(0);
  });

  it("opt-in needs an international phone number and the affiliate's own consent", async () => {
    await expect(affiliates.updateAffiliate(db, asAlice(), alice.id, { textChannel: "sms", textConsent: true })).rejects.toThrow(/phone number/);
    await expect(affiliates.updateAffiliate(db, asAlice(), alice.id, { phone: "+14155550100", textChannel: "sms" })).rejects.toThrow(/consent/);
    // the merchant cannot consent on the affiliate's behalf
    await expect(affiliates.updateAffiliate(db, ws.ctx, alice.id, { phone: "+14155550100", textChannel: "sms", textConsent: true })).rejects.toThrow(/only the affiliate/);
    alice = await affiliates.updateAffiliate(db, asAlice(), alice.id, { phone: "+1 (415) 555-0100", textChannel: "whatsapp", textConsent: true });
    expect(alice.phone).toBe("+14155550100");
    expect(alice.textChannel).toBe("whatsapp");
    expect(alice.textConsentAt).toBeTruthy();
    expect(alice.textOptOutAt).toBeNull();
  });

  it("sends the text template on the chosen channel in addition to email, and logs both", async () => {
    const logs = await messaging.sendNotification(db, ws.ctx, { email, text, textStatusUrl: "https://api.test/hooks/twilio/t/status" }, { key: "payout_paid", to: alice.email, vars: { amount: "42.00", currency: "USD", payout_date: "2026-01-31", business_name: ws.tenant.name }, affiliateId: alice.id, affiliate: alice });
    expect(logs.map((l) => [l.channel, l.status])).toEqual([
      ["email", "sent"],
      ["whatsapp", "sent"],
    ]);
    expect(text.sent.at(-1)).toMatchObject({ to: "+14155550100", channel: "whatsapp", body: "Paid 42.00 USD — " + ws.tenant.name, statusCallbackUrl: "https://api.test/hooks/twilio/t/status" });
    expect(logs[1]!.providerMessageId).toMatch(/^SMmem/);
  });

  it("records provider delivery status against the log by provider message id", async () => {
    const [sent] = await db.select().from(messageLogs).where(eq(messageLogs.channel, "whatsapp"));
    const updated = await messaging.recordDeliveryStatus(db, ws.ctx, sent!.providerMessageId!, "delivered");
    expect(updated!.status).toBe("delivered");
    expect(updated!.deliveredAt).toBeTruthy();
    expect(await messaging.recordDeliveryStatus(db, ws.ctx, "SMunknown", "failed")).toBeNull();
  });

  it("skips with a reason when the provider cannot serve the channel or the send fails", async () => {
    const smsOnly = new MemoryTextProvider(["sms"]);
    let logs = await messaging.sendNotification(db, ws.ctx, { email, text: smsOnly }, { key: "commission_approved", to: alice.email, vars: {}, affiliateId: alice.id, affiliate: alice });
    expect(logs[1]).toMatchObject({ channel: "whatsapp", status: "skipped", error: "text provider has no whatsapp sender" });
    logs = await messaging.sendNotification(db, ws.ctx, { email, text: null }, { key: "commission_approved", to: alice.email, vars: {}, affiliateId: alice.id, affiliate: alice });
    expect(logs[1]).toMatchObject({ status: "skipped", error: "no text provider connected" });
    text.failNext = "twilio 400 (63016): outside session";
    logs = await messaging.sendNotification(db, ws.ctx, { email, text }, { key: "commission_approved", to: alice.email, vars: {}, affiliateId: alice.id, affiliate: alice });
    expect(logs[1]).toMatchObject({ status: "failed", error: "twilio 400 (63016): outside session" });
  });

  it("automation can send a custom text, rendered with variables", async () => {
    const before = text.sent.length;
    const rule = await automation.createRule(db, ws.ctx, { name: "Text on approval", trigger: "commission.approved", conditions: [], actions: [{ type: "send_text", body: "Nice one {{affiliate_name}}: {{amount}} {{currency}} approved" }] });
    const runs = await automation.runRulesForEvent(db, ws.ctx, { id: "evt_1", tenantId: ws.tenant.id, type: "commission.approved", entityType: "commission", entityId: "com_x", occurredAt: clock.now().toISOString(), data: { affiliateId: alice.id, amountMinor: 1234, currency: "USD" } } as never, { email, webUrl: "http://web.test", text });
    expect(runs[0]!.status).toBe("success");
    expect(text.sent).toHaveLength(before + 1);
    expect(text.sent.at(-1)!.body).toBe("Nice one Alice: 12.34 USD approved");
    await automation.updateRule(db, ws.ctx, rule.id, { enabled: false });
    await expect(automation.createRule(db, ws.ctx, { name: "bad", trigger: "commission.approved", conditions: [], actions: [{ type: "send_text", body: "{{nope}}" }] })).rejects.toThrow(/unknown template variable/);
  });

  it("STOP from the affiliate's number opts them out; START opts them back in; merchant cannot re-consent", async () => {
    expect(await affiliates.setTextOptOutByPhone(db, ws.ctx, "+19999999999", true)).toBeNull();
    const out = await affiliates.setTextOptOutByPhone(db, ws.ctx, "whatsapp:+14155550100", true);
    expect(out!.textOptOutAt).toBeTruthy();
    let logs = await messaging.sendNotification(db, ws.ctx, { email, text }, { key: "commission_approved", to: alice.email, vars: {}, affiliateId: alice.id, affiliate: out! });
    expect(logs[1]).toMatchObject({ status: "skipped", error: "affiliate opted out of text messages" });
    // the merchant may change the channel but cannot restore consent
    await expect(affiliates.updateAffiliate(db, ws.ctx, alice.id, { textChannel: "sms" })).resolves.toMatchObject({ textChannel: "sms" });
    logs = await messaging.sendNotification(db, ws.ctx, { email, text }, { key: "commission_approved", to: alice.email, vars: {}, affiliateId: alice.id, affiliate: (await affiliates.getAffiliate(db, ws.ctx, alice.id))! });
    expect(logs[1]!.status).toBe("skipped");
    clock.advanceDays(1);
    const back = await affiliates.setTextOptOutByPhone(db, ws.ctx, "+14155550100", false);
    expect(back!.textOptOutAt).toBeNull();
    logs = await messaging.sendNotification(db, ws.ctx, { email, text }, { key: "commission_approved", to: alice.email, vars: {}, affiliateId: alice.id, affiliate: back! });
    expect(logs[1]).toMatchObject({ channel: "sms", status: "sent" });
    // opting out in the portal
    const off = await affiliates.updateAffiliate(db, asAlice(), alice.id, { textChannel: null });
    expect(off.textChannel).toBeNull();
    expect(off.textOptOutAt).toBeTruthy();
  });

  it("Twilio adapter: request shape, WhatsApp addressing, messaging service and error surfacing", async () => {
    const sid = "AC" + "a".repeat(32);
    const ok = stubFetch(201, { sid: "SM123", status: "queued" });
    const p = new TwilioTextProvider({ accountSid: sid, authToken: "tok_secret_0123456789", fromSms: "+15005550006", fromWhatsApp: "+15005550007" }, { fetchImpl: ok.fetchImpl });
    expect(p.channels()).toEqual(["sms", "whatsapp"]);
    expect(await p.send({ to: "+14155550100", channel: "whatsapp", body: "hi", statusCallbackUrl: "https://api.test/s" })).toEqual({ providerMessageId: "SM123" });
    const call = ok.calls[0]!;
    expect(call.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`${sid}:tok_secret_0123456789`).toString("base64")}`);
    const form = new URLSearchParams(call.body);
    expect(form.get("To")).toBe("whatsapp:+14155550100");
    expect(form.get("From")).toBe("whatsapp:+15005550007");
    expect(form.get("StatusCallback")).toBe("https://api.test/s");
    await p.send({ to: "+14155550100", channel: "sms", body: "hi" });
    expect(new URLSearchParams(ok.calls[1]!.body).get("From")).toBe("+15005550006");

    const svc = new TwilioTextProvider({ accountSid: sid, authToken: "tok_secret_0123456789", fromSms: "MG" + "b".repeat(32) }, { fetchImpl: ok.fetchImpl });
    expect(svc.channels()).toEqual(["sms"]);
    await svc.send({ to: "+14155550100", channel: "sms", body: "hi" });
    expect(new URLSearchParams(ok.calls[2]!.body).get("MessagingServiceSid")).toBe("MG" + "b".repeat(32));
    await expect(svc.send({ to: "+14155550100", channel: "whatsapp", body: "hi" })).rejects.toThrow(/no WhatsApp sender/);

    const bad = stubFetch(400, { code: 63016, message: "Failed to send freeform message" });
    const failing = new TwilioTextProvider({ accountSid: sid, authToken: "tok_secret_0123456789", fromSms: "+15005550006" }, { fetchImpl: bad.fetchImpl });
    await expect(failing.send({ to: "+14155550100", channel: "sms", body: "hi" })).rejects.toThrow("twilio 400 (63016): Failed to send freeform message");
    const unauth = stubFetch(401, { message: "Authenticate" });
    expect(await new TwilioTextProvider({ accountSid: sid, authToken: "x".repeat(20) }, { fetchImpl: unauth.fetchImpl }).verifyCredentials()).toMatchObject({ ok: false, detail: /auth token/ });
  });

  it("connects Twilio per tenant with verified, encrypted credentials and resolves it for sends", async () => {
    const sid = "AC" + "c".repeat(32);
    const verify = stubFetch(200, { status: "active" });
    const deps: integrations.TextDeps = { providerOptions: { fetchImpl: verify.fetchImpl }, fallback: new MemoryTextProvider() };
    await expect(integrations.connectTextProvider(db, ws.ctx, "twilio", { accountSid: "nope", authToken: "x".repeat(20) }, deps)).rejects.toThrow();
    await expect(integrations.connectTextProvider(db, ws.ctx, "twilio", { accountSid: sid, authToken: "x".repeat(20) }, deps)).rejects.toThrow(/sender/);
    expect((await integrations.textProviderFor(db, ws.ctx, deps))!.id).toBe("memory"); // fallback before connecting
    const row = await integrations.connectTextProvider(db, ws.ctx, "twilio", { accountSid: sid, authToken: "tok_secret_0123456789", fromWhatsApp: "+15005550007" }, deps);
    expect(row.hint).toBe("ACcccc… · WhatsApp +15005550007");
    expect(row.credentialsEnc).not.toContain("tok_secret");
    expect(verify.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`);
    const provider = await integrations.textProviderFor(db, ws.ctx, deps);
    expect(provider!.id).toBe("twilio");
    expect(provider!.channels()).toEqual(["whatsapp"]);
    expect(await integrations.twilioAuthToken(db, ws.ctx)).toBe("tok_secret_0123456789");
    expect((await integrations.listIntegrations(db, ws.ctx)).map((i) => i.provider)).toContain("twilio");
    expect(await integrations.connectedProviders(db, ws.ctx)).not.toContain("twilio"); // payout list stays payout-only
    await integrations.disconnectTextProvider(db, ws.ctx, "twilio");
    expect(await integrations.twilioAuthToken(db, ws.ctx)).toBeNull();
  });

  it("verifies Twilio webhook signatures", () => {
    const url = "https://api.test/hooks/twilio/ten_1/status";
    const params = { MessageSid: "SM1", MessageStatus: "delivered", To: "+1" };
    const sig = twilioSignature("token", url, params);
    expect(verifyTwilioSignature("token", url, params, sig)).toBe(true);
    expect(verifyTwilioSignature("token", url, { ...params, MessageStatus: "failed" }, sig)).toBe(false);
    expect(verifyTwilioSignature("other", url, params, sig)).toBe(false);
    expect(verifyTwilioSignature("token", url, params, undefined)).toBe(false);
  });
});
