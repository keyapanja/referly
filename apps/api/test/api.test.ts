import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, messaging, type DbHandle } from "@referly/core";
import { createApp, type App } from "../src/app";
import { runOnce } from "../src/worker";

/**
 * End-to-end walk through the PRD's MVP acceptance criteria (s17) over HTTP:
 * onboarding → offer → program → invite → affiliate accepts → link → click → conversion
 * webhook (twice) → commission → refund → holding period → payout → notifications → audit.
 */

let handle: DbHandle;
let app: App;
let clock = new Date("2026-03-01T10:00:00Z");
const now = () => new Date(clock);
const email = new messaging.MemoryEmailProvider();
const BASE = "http://api.test";

beforeAll(async () => {
  handle = await createDb();
  app = createApp({ db: handle.db, email, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
});
afterAll(() => handle.close());

async function call<T = any>(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await app.request(BASE + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, redirect: "manual" });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

describe("MVP acceptance over HTTP", () => {
  let ownerToken: string;
  let apiKey: string;
  let offerId: string;
  let programId: string;
  let affiliateId: string;
  let affiliateToken: string;
  let clickToken: string;
  let conversionId: string;
  let commissionId: string;

  it("Onboarding: a merchant creates a tenant, offer and program without support", async () => {
    const signup = await call("/v1/auth/signup", { method: "POST", json: { name: "Coach Co", slug: "coach-co", currency: "INR", owner: { name: "Priya", email: "priya@coach.co", password: "supersecret1" } } });
    expect(signup.status).toBe(201);
    ownerToken = signup.body.token;
    expect(signup.headers.get("set-cookie")).toContain("referly_session=");

    const offer = await call("/v1/offers", { method: "POST", token: ownerToken, json: { name: "90-day Coaching", type: "coaching", priceMinor: 2_500_000, salesUrl: "https://coach.co/90-day" } });
    expect(offer.status).toBe(201);
    offerId = offer.body.offer.id;
    expect((await call(`/v1/offers/${offerId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } })).status).toBe(200);

    const program = await call("/v1/programs", { method: "POST", token: ownerToken, json: { name: "Alumni Partners", commissionModel: "percentage", commissionPercent: 20, holdingDays: 30, offerIds: [offerId], termsText: "Be nice." } });
    expect(program.status).toBe(201);
    programId = program.body.program.id;
    expect((await call(`/v1/programs/${programId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } })).status).toBe(200);
    const detail = await call(`/v1/programs/${programId}`, { token: ownerToken });
    expect(detail.body.joinUrl).toMatch(/\/join\//);

    const key = await call("/v1/tenant/api-keys", { method: "POST", token: ownerToken, json: { name: "checkout webhook" } });
    expect(key.status).toBe(201);
    apiKey = key.body.secret;
    expect(apiKey).toMatch(/^rk_live_/);
  });

  it("Affiliate: an invited affiliate accepts terms and gets a branded portal; invite email is logged", async () => {
    const invite = await call("/v1/affiliates/invites", { method: "POST", token: ownerToken, json: { programId, email: "sam@partner.io", name: "Sam" } });
    expect(invite.status).toBe(201);
    const acceptToken = invite.body.invite.token;

    await runOnce({ db: handle.db, email, webUrl: "http://web.test", now });
    const inviteMail = email.sent.find((m) => m.to === "sam@partner.io");
    expect(inviteMail?.subject).toBe("You're invited to join Alumni Partners");
    expect(inviteMail?.body).toContain(`http://web.test/invite/${acceptToken}`);

    const page = await call(`/invite/${acceptToken}`);
    expect(page.status).toBe(200);
    expect(page.body.tenant.name).toBe("Coach Co");
    expect(page.body.program.termsText).toBe("Be nice.");

    const accept = await call(`/invite/${acceptToken}/accept`, { method: "POST", json: { name: "Sam Partner", password: "partnerpass1", acceptTerms: true } });
    expect(accept.status).toBe(201);
    affiliateToken = accept.body.token;
    affiliateId = accept.body.affiliate.id;

    const me = await call("/portal/me", { token: affiliateToken });
    expect(me.status).toBe(200);
    expect(me.body.tenant.name).toBe("Coach Co");
    expect(me.body.memberships[0]).toMatchObject({ programId, status: "active", termsVersion: 1 });

    // affiliates cannot reach merchant routes
    expect((await call("/v1/affiliates", { token: affiliateToken })).status).toBe(403);
    // and unauthenticated calls are rejected
    expect((await call("/v1/offers")).status).toBe(401);
  });

  it("Tracking: a unique link identifies a click and preserves attribution through a redirect", async () => {
    const offers = await call("/portal/offers", { token: affiliateToken });
    expect(offers.body.offers).toHaveLength(1);
    const link = await call("/portal/links", { method: "POST", token: affiliateToken, json: { programId, offerId } });
    expect(link.status).toBe(201);
    expect(link.body.link.url).toMatch(new RegExp(`^${BASE}/r/`));

    const redirect = await call(`/r/${link.body.link.token}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone)" } });
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://coach.co/90-day");
    clickToken = location.searchParams.get("ref")!;
    expect(clickToken).toBeTruthy();
    const cookie = redirect.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`referly_clicks=${clickToken}`);
    expect(cookie).toMatch(/Max-Age=2592000/); // 30 days

    expect((await call(`/r/nope`)).status).toBe(404);
  });

  it("Conversions: a webhook creates exactly one conversion even when repeated", async () => {
    clock = new Date("2026-03-05T10:00:00Z");
    const payload = { externalOrderId: "ORDER-1001", offerId, amountMinor: 2_500_000, clickToken, customerEmail: "buyer@example.com" };
    const first = await call("/v1/conversions", { method: "POST", token: apiKey, json: payload });
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.conversion.source).toBe("webhook");
    expect(first.body.conversion.affiliateId).toBe(affiliateId);
    expect(first.body.conversion.customerEmailHash).toHaveLength(64);
    expect(first.body.attribution.ruleApplied).toBe("last_click");
    conversionId = first.body.conversion.id;
    commissionId = first.body.commission.id;

    const again = await call("/v1/conversions", { method: "POST", token: apiKey, json: payload });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.conversion.id).toBe(conversionId);

    const list = await call("/v1/conversions", { token: ownerToken });
    expect(list.body.conversions).toHaveLength(1);
  });

  it("Commissions: valid conversions produce predictable amounts using program rules", async () => {
    const c = await call(`/v1/commissions/${commissionId}`, { token: ownerToken });
    expect(c.body.commission).toMatchObject({ amountMinor: 500_000, currency: "INR", status: "pending" });
    expect(c.body.commission.calculationBasis).toMatchObject({ model: "percentage", rateBps: 2000, basisAmountMinor: 2_500_000, overrideSource: "program" });

    const portal = await call("/portal/home", { token: affiliateToken });
    expect(portal.body.balances.pendingMinor).toBe(500_000);
    expect(portal.body.metrics).toMatchObject({ clicks: 1, conversions: 1, revenueMinor: 2_500_000, conversionRate: 1 });

    await runOnce({ db: handle.db, email, webUrl: "http://web.test", now });
    expect(email.sent.find((m) => m.to === "sam@partner.io" && m.subject === "New sale attributed to you")?.body).toContain("25000.00 INR");
  });

  it("Refunds: a partial refund under a full policy reverses the commission and notifies", async () => {
    // record a second sale we can refund without disturbing the payout test
    const sale = await call("/v1/conversions", { method: "POST", token: apiKey, json: { externalOrderId: "ORDER-1002", offerId, amountMinor: 1_000_000, clickToken } });
    expect(sale.status).toBe(201);
    const refund = await call(`/v1/conversions/${sale.body.conversion.id}/refund`, { method: "POST", token: ownerToken, json: { amountMinor: 100_000, reason: "customer cancelled week 2" } });
    expect(refund.status).toBe(200);
    expect(refund.body.conversion.status).toBe("refunded");
    expect(refund.body.commission.status).toBe("reversed");
    await runOnce({ db: handle.db, email, webUrl: "http://web.test", now });
    expect(email.sent.some((m) => m.subject === "Commission adjusted" && m.body.includes("customer cancelled week 2"))).toBe(true);
  });

  it("Payouts: merchant sees payable commission after holding, creates a batch and records completion", async () => {
    clock = new Date("2026-04-10T10:00:00Z"); // > 30 days after the sale; sessions (14d) have expired, so sign in again
    expect((await call("/v1/commissions", { token: ownerToken })).status).toBe(401);
    ownerToken = (await call("/v1/auth/login", { method: "POST", json: { email: "priya@coach.co", password: "supersecret1" } })).body.token;
    affiliateToken = (await call("/v1/auth/login", { method: "POST", json: { email: "sam@partner.io", password: "partnerpass1" } })).body.token;
    const settle = await call("/v1/commissions/settle", { method: "POST", token: ownerToken });
    expect(settle.body.settled.map((s: any) => s.id)).toContain(commissionId);

    const payable = await call(`/v1/payouts/payable/${affiliateId}`, { token: ownerToken });
    expect(payable.body.totalMinor).toBe(500_000);

    const payout = await call("/v1/payouts", { method: "POST", token: ownerToken, json: { affiliateId } });
    expect(payout.status).toBe(201);
    expect(payout.body.payout.amountMinor).toBe(500_000);
    const paid = await call(`/v1/payouts/${payout.body.payout.id}/paid`, { method: "POST", token: ownerToken, json: { externalReference: "NEFT-778" } });
    expect(paid.body.payout.status).toBe("paid");

    const rec = await call(`/v1/payouts/${payout.body.payout.id}`, { token: ownerToken });
    expect(rec.body.reconciled).toBe(true);
    const portalPayouts = await call("/portal/payouts", { token: affiliateToken });
    expect(portalPayouts.body.payouts[0]).toMatchObject({ status: "paid", externalReference: "NEFT-778" });
    const earnings = await call("/portal/earnings", { token: affiliateToken });
    expect(earnings.body.balances).toMatchObject({ availableMinor: 0, paidMinor: 500_000 });

    await runOnce({ db: handle.db, email, webUrl: "http://web.test", now });
    expect(email.sent.some((m) => m.subject === "Payout sent" && m.body.includes("2026-04-10"))).toBe(true);
  });

  it("Notifications: message log records delivery status for key events", async () => {
    const log = await call("/v1/messages/log", { token: ownerToken });
    const keys = log.body.messages.map((m: any) => [m.templateKey, m.status]);
    expect(keys).toEqual(expect.arrayContaining([["affiliate_invite", "sent"], ["conversion_recorded", "sent"], ["commission_reversed", "sent"], ["payout_paid", "sent"]]));
  });

  it("Audit: financial and attribution changes carry actor, reason and before/after", async () => {
    const audit = await call(`/v1/tenant/audit?entityType=commission&entityId=${commissionId}`, { token: ownerToken });
    const actions = audit.body.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["status:payable"]));
    const refunded = await call(`/v1/tenant/audit?entityType=conversion`, { token: ownerToken });
    const entry = refunded.body.entries.find((e: any) => e.action === "refunded");
    expect(entry).toMatchObject({ actorType: "user", reason: "customer cancelled week 2", before: { status: "pending" }, after: { status: "refunded" } });
  });

  it("Isolation: a second tenant cannot reach the first tenant's data via URL manipulation", async () => {
    const other = await call("/v1/auth/signup", { method: "POST", json: { name: "Other Co", slug: "other-co", owner: { name: "Ola", email: "ola@other.co", password: "supersecret1" } } });
    const t = other.body.token;
    expect((await call(`/v1/offers/${offerId}`, { token: t })).status).toBe(404);
    expect((await call(`/v1/programs/${programId}`, { token: t })).status).toBe(404);
    expect((await call(`/v1/affiliates/${affiliateId}`, { token: t })).status).toBe(404);
    expect((await call(`/v1/conversions/${conversionId}`, { token: t })).status).toBe(404);
    expect((await call(`/v1/commissions/${commissionId}`, { token: t })).status).toBe(404);
    expect((await call(`/v1/conversions/${conversionId}/refund`, { method: "POST", token: t, json: { reason: "steal" } })).status).toBe(404);
    expect((await call("/v1/conversions", { token: t })).body.conversions).toHaveLength(0);
    // a click token from tenant 1 does not attribute in tenant 2
    const cross = await call("/v1/conversions", { method: "POST", token: t, json: { externalOrderId: "X-1", amountMinor: 100, clickToken } });
    expect(cross.body.conversion.affiliateId).toBeNull();
  });

  it("Application flow: public join page and self-serve application with manual approval", async () => {
    const detail = await call(`/v1/programs/${programId}`, { token: ownerToken });
    const joinToken = detail.body.joinUrl.split("/join/")[1];
    const page = await call(`/join/${joinToken}`);
    expect(page.status).toBe(200);
    expect(page.body.program.commissionPercent).toBe(20);
    expect(page.body.offers[0].name).toBe("90-day Coaching");

    const apply = await call(`/join/${joinToken}/apply`, { method: "POST", json: { name: "Nia", email: "nia@creator.io", password: "creatorpass1", channels: { youtube: "https://youtube.com/@nia" }, acceptTerms: true } });
    expect(apply.status).toBe(201);
    expect(apply.body.affiliate.status).toBe("applied");
    expect(apply.body.token).toBeNull();

    const pending = await call("/v1/affiliates?status=applied", { token: ownerToken });
    expect(pending.body.affiliates.map((a: any) => a.email)).toContain("nia@creator.io");
    const approve = await call(`/v1/affiliates/${apply.body.affiliate.id}/approve`, { method: "POST", token: ownerToken, json: {} });
    expect(approve.body.affiliate.status).toBe("active");

    const login = await call("/v1/auth/login", { method: "POST", json: { email: "nia@creator.io", password: "creatorpass1" } });
    expect(login.status).toBe(200);
    expect(login.body.affiliateId).toBe(apply.body.affiliate.id);
    const home = await call("/portal/home", { token: login.body.token });
    expect(home.status).toBe(200);
  });

  it("Validation and permissions errors are JSON with codes", async () => {
    const bad = await call("/v1/offers", { method: "POST", token: ownerToken, json: { name: "" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation");
    const ro = await call("/v1/tenant/team", { method: "POST", token: ownerToken, json: { name: "Reader", email: "reader@coach.co", password: "readerpass1", role: "readonly" } });
    expect(ro.status).toBe(201);
    const login = await call("/v1/auth/login", { method: "POST", json: { email: "reader@coach.co", password: "readerpass1" } });
    const denied = await call("/v1/offers", { method: "POST", token: login.body.token, json: { name: "x", salesUrl: "https://coach.co/x" } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("forbidden");
  });
});
