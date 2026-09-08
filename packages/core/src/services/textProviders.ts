import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * SMS / WhatsApp provider adapters (PRD s14 "WhatsApp provider", Phase 2 "WhatsApp/SMS").
 * Same shape as the payout adapters: plain HTTPS through an injectable `fetch`, no SDKs, so
 * request shapes are unit-tested with a stub. Twilio carries both channels; WhatsApp numbers are
 * addressed as `whatsapp:+E164`.
 *
 * WhatsApp note: business-initiated messages outside a 24-hour customer session must use a
 * template approved by Meta. Configure your approved templates to match the text templates
 * in the Messages page; Twilio rejects unapproved free-form sends with error 63016, which is
 * recorded on the message log.
 */

export type TextChannel = "sms" | "whatsapp";
export const TEXT_CHANNELS: TextChannel[] = ["sms", "whatsapp"];

export type TextProviderId = "twilio";
export const TEXT_PROVIDER_IDS: TextProviderId[] = ["twilio"];

export interface TextMessage {
  /** E.164 phone number. */
  to: string;
  channel: TextChannel;
  body: string;
  /** Where the provider should report delivery status (Twilio StatusCallback). */
  statusCallbackUrl?: string;
}

export interface TextProvider {
  readonly id: string;
  readonly label: string;
  /** Channels this configuration can send on (e.g. Twilio without a WhatsApp sender → sms only). */
  channels(): TextChannel[];
  verifyCredentials(): Promise<{ ok: boolean; detail?: string }>;
  send(message: TextMessage): Promise<{ providerMessageId?: string }>;
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** Sender for SMS: an E.164 number or a Messaging Service SID (MG…). */
  fromSms?: string;
  /** WhatsApp-enabled sender, E.164. */
  fromWhatsApp?: string;
}

export type TextCredentials = TwilioCredentials;

export interface TextProviderOptions {
  fetchImpl?: typeof fetch;
}

export type TextProviderFactory = (provider: TextProviderId, credentials: TextCredentials, options?: TextProviderOptions) => TextProvider;

export const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Strip formatting; accepts "+91 98765 43210", "(415) 555-0100" only with a leading +. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/^whatsapp:/i, "").replace(/[\s().-]/g, "");
  return E164_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

const TWILIO_API = "https://api.twilio.com/2010-04-01";

export class TwilioTextProvider implements TextProvider {
  readonly id = "twilio";
  readonly label = "Twilio";
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly creds: TwilioCredentials,
    options: TextProviderOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  channels(): TextChannel[] {
    const out: TextChannel[] = [];
    if (this.creds.fromSms) out.push("sms");
    if (this.creds.fromWhatsApp) out.push("whatsapp");
    return out;
  }

  private auth() {
    return `Basic ${Buffer.from(`${this.creds.accountSid}:${this.creds.authToken}`).toString("base64")}`;
  }

  async verifyCredentials() {
    const res = await this.fetchImpl(`${TWILIO_API}/Accounts/${this.creds.accountSid}.json`, { headers: { authorization: this.auth() } });
    if (res.status === 401) return { ok: false, detail: "Twilio rejected the account SID / auth token" };
    if (!res.ok) return { ok: false, detail: `Twilio responded ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { status?: string };
    if (data.status && data.status !== "active") return { ok: false, detail: `Twilio account is ${data.status}` };
    return { ok: true };
  }

  async send(message: TextMessage) {
    const form = new URLSearchParams();
    form.set("Body", message.body);
    if (message.channel === "whatsapp") {
      if (!this.creds.fromWhatsApp) throw new Error("no WhatsApp sender configured for Twilio");
      form.set("To", `whatsapp:${message.to}`);
      form.set("From", `whatsapp:${this.creds.fromWhatsApp}`);
    } else {
      if (!this.creds.fromSms) throw new Error("no SMS sender configured for Twilio");
      form.set("To", message.to);
      form.set(this.creds.fromSms.startsWith("MG") ? "MessagingServiceSid" : "From", this.creds.fromSms);
    }
    if (message.statusCallbackUrl) form.set("StatusCallback", message.statusCallbackUrl);
    const res = await this.fetchImpl(`${TWILIO_API}/Accounts/${this.creds.accountSid}/Messages.json`, {
      method: "POST",
      headers: { authorization: this.auth(), "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok) throw new Error(`twilio ${res.status}${data.code ? ` (${data.code})` : ""}: ${data.message ?? "send failed"}`);
    return { providerMessageId: data.sid };
  }
}

/**
 * Twilio signs webhooks with HMAC-SHA1 over the full URL plus the POST parameters sorted by
 * key and concatenated as key+value. Compared in constant time.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// Dev / test providers
// ---------------------------------------------------------------------------

export class MemoryTextProvider implements TextProvider {
  readonly id = "memory";
  readonly label = "In-memory";
  readonly sent: TextMessage[] = [];
  failNext: string | null = null;
  constructor(private readonly available: TextChannel[] = ["sms", "whatsapp"]) {}
  channels() {
    return this.available;
  }
  async verifyCredentials() {
    return { ok: true };
  }
  async send(message: TextMessage) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw new Error(err);
    }
    this.sent.push(message);
    return { providerMessageId: `SMmem${this.sent.length}` };
  }
}

export class ConsoleTextProvider implements TextProvider {
  readonly id = "console";
  readonly label = "Console";
  channels(): TextChannel[] {
    return ["sms", "whatsapp"];
  }
  async verifyCredentials() {
    return { ok: true };
  }
  async send(message: TextMessage) {
    console.log(`[${message.channel}] to=${message.to}\n${message.body}\n`);
    return {};
  }
}

export function createTextProvider(provider: TextProviderId, credentials: TextCredentials, options: TextProviderOptions = {}): TextProvider {
  switch (provider) {
    case "twilio":
      return new TwilioTextProvider(credentials, options);
    default:
      throw new Error(`unknown text provider ${provider as string}`);
  }
}
