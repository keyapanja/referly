/**
 * Payout provider adapters (PRD s14 "Payment/payout provider", PAY-01, PAY-05). Each adapter
 * talks plain HTTPS through an injectable `fetch`, so the request shapes are unit-tested with
 * a stub and the core stays free of provider SDKs. Providers never see raw bank details: Stripe
 * pays connected accounts (acct_…) and PayPal pays an email address.
 */

export type PayoutProviderId = "stripe_connect" | "paypal";
export const PAYOUT_PROVIDER_IDS: PayoutProviderId[] = ["stripe_connect", "paypal"];

/** Affiliate payout method → provider that can pay it. */
export const PROVIDER_FOR_METHOD: Record<string, PayoutProviderId> = { stripe_connect: "stripe_connect", paypal: "paypal" };

export interface PayoutRequest {
  payoutId: string;
  affiliateId: string;
  amountMinor: number;
  currency: string;
  /** Provider destination: Stripe connected account id or PayPal email. */
  destinationRef: string;
  /** Stable per payout so retries never pay twice. */
  idempotencyKey: string;
  description: string;
}

export interface PayoutResult {
  status: "paid" | "processing" | "failed";
  providerRef?: string;
  providerStatus?: string;
  error?: string;
}

export interface OnboardingArgs {
  affiliateId: string;
  email: string;
  name: string;
  returnUrl: string;
  refreshUrl: string;
  existingAccountId?: string | null;
}

export interface PayoutProvider {
  readonly id: PayoutProviderId;
  readonly label: string;
  verifyCredentials(): Promise<{ ok: boolean; detail?: string }>;
  send(req: PayoutRequest): Promise<PayoutResult>;
  /** Re-check an asynchronous payout by its provider reference. */
  poll?(providerRef: string): Promise<PayoutResult>;
  /** Connected-account onboarding (Stripe Connect Express). */
  createOnboardingLink?(args: OnboardingArgs): Promise<{ url: string; accountId: string }>;
}

export interface StripeCredentials {
  secretKey: string;
}
export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  sandbox?: boolean;
}
export type ProviderCredentials = StripeCredentials | PayPalCredentials;

export interface ProviderOptions {
  fetchImpl?: typeof fetch;
}

function form(data: Record<string, string | number | undefined>): string {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

// ---------------------------------------------------------------------------
// Stripe Connect: transfers to connected accounts
// ---------------------------------------------------------------------------

export class StripeConnectProvider implements PayoutProvider {
  readonly id = "stripe_connect" as const;
  readonly label = "Stripe Connect";
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly creds: StripeCredentials,
    opts: ProviderOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(method: "GET" | "POST", path: string, body?: Record<string, string | number | undefined>, idempotencyKey?: string) {
    const res = await this.fetchImpl(`https://api.stripe.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.creds.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body ? form(body) : undefined,
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data?.error?.message ?? `stripe ${res.status}`);
    return data;
  }

  async verifyCredentials() {
    try {
      await this.call("GET", "/v1/balance");
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async send(req: PayoutRequest): Promise<PayoutResult> {
    try {
      const tr = await this.call("POST", "/v1/transfers", { amount: req.amountMinor, currency: req.currency.toLowerCase(), destination: req.destinationRef, description: req.description, transfer_group: req.payoutId }, req.idempotencyKey);
      // A transfer is settled synchronously into the connected account's balance.
      return { status: "paid", providerRef: tr.id, providerStatus: "transferred" };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async createOnboardingLink(args: OnboardingArgs) {
    const accountId = args.existingAccountId ?? (await this.call("POST", "/v1/accounts", { type: "express", email: args.email, "metadata[affiliateId]": args.affiliateId, "business_profile[name]": args.name })).id;
    const link = await this.call("POST", "/v1/account_links", { account: accountId, refresh_url: args.refreshUrl, return_url: args.returnUrl, type: "account_onboarding" });
    return { url: link.url as string, accountId: accountId as string };
  }
}

// ---------------------------------------------------------------------------
// PayPal Payouts: asynchronous batches paid to an email address
// ---------------------------------------------------------------------------

export class PayPalPayoutsProvider implements PayoutProvider {
  readonly id = "paypal" as const;
  readonly label = "PayPal Payouts";
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;
  constructor(
    private readonly creds: PayPalCredentials,
    opts: ProviderOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get base() {
    return this.creds.sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const data = await readJson(res);
    if (!res.ok || !data.access_token) throw new Error(data?.error_description ?? data?.error ?? `paypal auth ${res.status}`);
    this.token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in ?? 3600) - 60) * 1000 };
    return this.token.value;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown) {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data?.message ?? data?.name ?? `paypal ${res.status}`);
    return data;
  }

  async verifyCredentials() {
    try {
      await this.accessToken();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private static mapItemStatus(status: string | undefined): PayoutResult["status"] {
    switch (status) {
      case "SUCCESS":
        return "paid";
      case "FAILED":
      case "DENIED":
      case "CANCELED":
      case "BLOCKED":
      case "RETURNED":
      case "REVERSED":
      case "REFUNDED":
        return "failed";
      default:
        return "processing";
    }
  }

  async send(req: PayoutRequest): Promise<PayoutResult> {
    try {
      const data = await this.call("POST", "/v1/payments/payouts", {
        sender_batch_header: { sender_batch_id: req.idempotencyKey, email_subject: "You have a payout", email_message: req.description },
        items: [{ recipient_type: "EMAIL", receiver: req.destinationRef, amount: { value: (req.amountMinor / 100).toFixed(2), currency: req.currency.toUpperCase() }, note: req.description, sender_item_id: req.payoutId }],
      });
      const batchId = data?.batch_header?.payout_batch_id as string | undefined;
      const status = PayPalPayoutsProvider.mapItemStatus(data?.batch_header?.batch_status);
      return { status: status === "failed" ? "failed" : "processing", providerRef: batchId, providerStatus: data?.batch_header?.batch_status };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async poll(providerRef: string): Promise<PayoutResult> {
    try {
      const data = await this.call("GET", `/v1/payments/payouts/${encodeURIComponent(providerRef)}`);
      const item = data?.items?.[0];
      const itemStatus = item?.transaction_status as string | undefined;
      const status = PayPalPayoutsProvider.mapItemStatus(itemStatus ?? data?.batch_header?.batch_status);
      return { status, providerRef, providerStatus: itemStatus ?? data?.batch_header?.batch_status, error: status === "failed" ? (item?.errors?.message ?? itemStatus) : undefined };
    } catch (err) {
      return { status: "processing", providerRef, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory provider for tests and local demos
// ---------------------------------------------------------------------------

export class MemoryPayoutProvider implements PayoutProvider {
  readonly id: PayoutProviderId;
  readonly label = "Memory";
  readonly sent: PayoutRequest[] = [];
  readonly onboarded: OnboardingArgs[] = [];
  mode: "paid" | "processing" | "failed" = "paid";
  pollMode: "paid" | "processing" | "failed" = "paid";
  constructor(id: PayoutProviderId = "stripe_connect") {
    this.id = id;
  }
  async verifyCredentials() {
    return { ok: true };
  }
  async send(req: PayoutRequest): Promise<PayoutResult> {
    this.sent.push(req);
    if (this.mode === "failed") return { status: "failed", error: "declined by test provider" };
    return { status: this.mode, providerRef: `${this.id === "paypal" ? "PB" : "tr"}_mem_${this.sent.length}`, providerStatus: this.mode };
  }
  async poll(providerRef: string): Promise<PayoutResult> {
    if (this.pollMode === "failed") return { status: "failed", providerRef, error: "failed on poll" };
    return { status: this.pollMode, providerRef, providerStatus: this.pollMode };
  }
  async createOnboardingLink(args: OnboardingArgs) {
    this.onboarded.push(args);
    return { url: `https://connect.example.test/onboard/${args.affiliateId}`, accountId: args.existingAccountId ?? `acct_mem_${args.affiliateId.slice(-6)}` };
  }
}

export type PayoutProviderFactory = (id: PayoutProviderId, credentials: ProviderCredentials, opts?: ProviderOptions) => PayoutProvider;

export const createPayoutProvider: PayoutProviderFactory = (id, credentials, opts = {}) => {
  switch (id) {
    case "stripe_connect":
      return new StripeConnectProvider(credentials as StripeCredentials, opts);
    case "paypal":
      return new PayPalPayoutsProvider(credentials as PayPalCredentials, opts);
  }
};
