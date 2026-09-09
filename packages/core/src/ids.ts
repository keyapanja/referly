import { customAlphabet } from "nanoid";

// URL-safe, no ambiguous characters. 21 chars ~ 126 bits of entropy.
const alphabet = "0123456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const gen = customAlphabet(alphabet, 21);
const genShort = customAlphabet(alphabet, 10);

export const ID_PREFIXES = {
  tenant: "ten",
  user: "usr",
  session: "ses",
  apiKey: "key",
  offer: "off",
  program: "prg",
  affiliate: "aff",
  invite: "inv",
  trackingLink: "lnk",
  couponCode: "cpn",
  click: "clk",
  conversion: "cnv",
  attribution: "att",
  commission: "com",
  ledgerEntry: "led",
  payout: "pay",
  asset: "ast",
  campaign: "cmp",
  messageTemplate: "tpl",
  messageLog: "msg",
  automationRule: "rul",
  automationRun: "run",
  auditLog: "aud",
  job: "job",
  webhookEndpoint: "whk",
  webhookDelivery: "whd",
  authToken: "tok",
  assetPermission: "asp",
  export: "exp",
  campaignParticipant: "cpp",
  campaignAsset: "cpa",
  task: "tsk",
  webhookSubscription: "whs",
  disputeComment: "dsc",
  dispute: "dsp",
  integration: "int",
  rateTier: "tier",
  affiliateGroupMember: "grm",
  affiliateGroup: "grp",
  maintenanceRun: "mnt",
  notification: "ntf",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${gen()}`;
}

/** Short opaque token for public URLs (tracking links, invites). */
export function newToken(length = 10): string {
  return length === 10 ? genShort() : customAlphabet(alphabet, length)();
}

/** Longer secret for API keys and session tokens. */
export function newSecret(): string {
  return customAlphabet(alphabet, 40)();
}
