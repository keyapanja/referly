import { textProviders, type integrations } from "@referly/core";

/**
 * Text (SMS/WhatsApp) provider defaults. Merchants connect their own Twilio account in Settings;
 * this only decides what happens when a workspace has none:
 *  - TEXT_FALLBACK=console (default outside production): print texts to stdout
 *  - TEXT_FALLBACK=none: texts are skipped and logged as such
 *  - TEXT_FALLBACK=twilio: a platform-wide Twilio account (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *    TWILIO_FROM_SMS and/or TWILIO_FROM_WHATSAPP) sends on behalf of every workspace
 */
export function createTextDeps(env: NodeJS.ProcessEnv = process.env): integrations.TextDeps {
  const kind = (env.TEXT_FALLBACK ?? (env.NODE_ENV === "production" ? "none" : "console")).toLowerCase();
  switch (kind) {
    case "console":
      return { fallback: new textProviders.ConsoleTextProvider() };
    case "none":
      return { fallback: null };
    case "twilio": {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required when TEXT_FALLBACK=twilio");
      if (!env.TWILIO_FROM_SMS && !env.TWILIO_FROM_WHATSAPP) throw new Error("set TWILIO_FROM_SMS and/or TWILIO_FROM_WHATSAPP when TEXT_FALLBACK=twilio");
      return { fallback: new textProviders.TwilioTextProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromSms: env.TWILIO_FROM_SMS, fromWhatsApp: env.TWILIO_FROM_WHATSAPP }) };
    }
    default:
      throw new Error(`unknown TEXT_FALLBACK ${kind}`);
  }
}

/** Where providers post delivery status and inbound keywords (STOP/START) for a tenant. */
export function textStatusUrl(baseUrl: string, tenantId: string): string {
  return `${baseUrl}/hooks/twilio/${tenantId}/status`;
}
