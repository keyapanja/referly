import { messaging } from "@referly/core";

/**
 * Email provider selection (PRD s14 P0 "Email provider"). Chosen by EMAIL_PROVIDER:
 *  - console (default): print to stdout; fine for local development
 *  - resend: HTTPS API, needs RESEND_API_KEY and EMAIL_FROM
 *  - smtp: any SMTP server via SMTP_URL (smtp://user:pass@host:587) and EMAIL_FROM
 * The core never sees provider details; it only calls `send`.
 */
export function createEmailProvider(env: NodeJS.ProcessEnv = process.env): messaging.EmailProvider {
  const kind = (env.EMAIL_PROVIDER ?? (env.NODE_ENV === "production" ? "" : "console")).toLowerCase();
  if (!kind) throw new Error("EMAIL_PROVIDER is required in production (resend or smtp); the console provider prints one-time links to stdout");
  const from = env.EMAIL_FROM ?? "no-reply@example.com";
  switch (kind) {
    case "resend":
      if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
      return new ResendEmailProvider(env.RESEND_API_KEY, from);
    case "smtp":
      if (!env.SMTP_URL) throw new Error("SMTP_URL is required when EMAIL_PROVIDER=smtp");
      return new SmtpEmailProvider(env.SMTP_URL, from);
    case "console":
      return new messaging.ConsoleEmailProvider();
    default:
      throw new Error(`unknown EMAIL_PROVIDER ${kind}`);
  }
}

export class ResendEmailProvider implements messaging.EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: messaging.OutboundMessage) {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.body }),
    });
    if (!res.ok) throw new Error(`resend responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { id?: string };
    return { providerMessageId: data.id };
  }
}

export class SmtpEmailProvider implements messaging.EmailProvider {
  private transport: Promise<{ sendMail: (m: Record<string, unknown>) => Promise<{ messageId?: string }> }> | null = null;
  constructor(
    private readonly url: string,
    private readonly from: string,
  ) {}

  private async transporter() {
    if (!this.transport) {
      this.transport = import("nodemailer").then((m) => m.default.createTransport(this.url));
    }
    return this.transport;
  }

  async send(message: messaging.OutboundMessage) {
    const t = await this.transporter();
    const info = await t.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.body });
    return { providerMessageId: info.messageId };
  }
}
