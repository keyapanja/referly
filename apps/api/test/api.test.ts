import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, messaging, platform, withRlsBypass, type DbHandle } from "@referly/core";
import { createApp, type App } from "../src/app";
import { runOnce } from "../src/worker";
import { resetRateLimits } from "../src/lib/ratelimit";
import { LocalStorage } from "../src/storage";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * End-to-end walk through the PRD's MVP acceptance criteria (s17) over HTTP:
 * onboarding → offer → program → invite → affiliate accepts → link → click → conversion
 * webhook (twice) → commission → refund → holding period → payout → notifications → audit.
 */

let handle: DbHandle;
let storage: LocalStorage;
let app: App;
let clock = new Date("2026-03-01T10:00:00Z");
const now = () => new Date(clock);
const email = new messaging.MemoryEmailProvider();
const BASE = "http://api.test";

beforeAll(async () => {
  handle = await createDb();
  storage = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-files-")), BASE);
  app = createApp({ db: handle.db, email, storage, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
});
afterAll(() => handle.close());
beforeAll(() => resetRateLimits());

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

    await runOnce({ db: handle.db, email, storage, webUrl: "http://web.test", now });
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

    await runOnce({ db: handle.db, email, storage, webUrl: "http://web.test", now });
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
    await runOnce({ db: handle.db, email, storage, webUrl: "http://web.test", now });
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

    await runOnce({ db: handle.db, email, storage, webUrl: "http://web.test", now });
    expect(email.sent.some((m) => m.subject === "Payout sent" && m.body.includes("2026-04-10"))).toBe(true);
  });

  it("Analytics: merchant can view attributed revenue, clicks, conversions and commissions", async () => {
    const overview = await call("/v1/analytics/overview?from=2026-02-01T00:00:00Z&to=2026-05-01T00:00:00Z", { token: ownerToken });
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ clicks: 1, attributedConversions: 2, attributedRevenueMinor: 3_400_000, activeAffiliates: 1 });
    expect(overview.body.commissionByStatus.paid.totalMinor).toBe(500_000);
    expect(overview.body.topAffiliates[0]).toMatchObject({ affiliateId, clicks: 1, conversions: 2 });
    const byOffer = await call("/v1/analytics/offers?from=2026-02-01T00:00:00Z&to=2026-05-01T00:00:00Z", { token: ownerToken });
    expect(byOffer.body.rows[0]).toMatchObject({ offerId, conversions: 2 });
    const csv = await call("/v1/analytics/export/conversions", { token: ownerToken });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(String(csv.body).trim().split("\n")).toHaveLength(3); // header + 2 rows
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

  it("Assets: affiliates only see assets permitted for their program (AST-02)", async () => {
    const pub = await call("/v1/assets", { method: "POST", token: ownerToken, json: { type: "copy", title: "Pitch", body: "Say this." } });
    expect(pub.status).toBe(201);
    const other = await call("/v1/programs", { method: "POST", token: ownerToken, json: { name: "Other", commissionModel: "fixed", commissionFixedMinor: 100, offerIds: [offerId] } });
    const restricted = await call("/v1/assets", { method: "POST", token: ownerToken, json: { type: "pdf", title: "Secret deck", url: "https://cdn.example.com/deck.pdf", visibility: "restricted", programIds: [other.body.program.id] } });
    expect(restricted.status).toBe(201);
    const mine = await call("/portal/assets", { token: affiliateToken });
    expect(mine.status).toBe(200);
    expect(mine.body.assets.map((a: any) => a.title)).toEqual(["Pitch"]);
    await call(`/v1/assets/${restricted.body.asset.id}/permissions`, { method: "PUT", token: ownerToken, json: { programIds: [programId] } });
    expect((await call("/portal/assets", { token: affiliateToken })).body.assets.map((a: any) => a.title).sort()).toEqual(["Pitch", "Secret deck"]);
    expect((await call("/v1/assets", { token: affiliateToken })).status).toBe(403);
  });

  it("Exports: async CSV export runs in the worker, is private, and downloads for the owner only", async () => {
    const req = await call("/v1/analytics/exports", { method: "POST", token: ownerToken, json: { entity: "conversions" } });
    expect(req.status).toBe(202);
    expect(req.body.export.status).toBe("queued");
    const id = req.body.export.id;
    expect((await call(`/v1/analytics/exports/${id}/download`, { token: ownerToken })).status).toBe(400); // not ready

    await runOnce({ db: handle.db, email, storage, webUrl: "http://web.test", now });
    const done = await call(`/v1/analytics/exports/${id}`, { token: ownerToken });
    expect(done.body.export).toMatchObject({ status: "done", rowCount: 2 });
    expect(done.body.export.storageKey).toMatch(/^private\/tenants\//);
    // private objects are not served publicly
    expect((await app.request(BASE + "/files/" + done.body.export.storageKey)).status).toBe(404);

    const dl = await call(`/v1/analytics/exports/${id}/download`, { token: ownerToken });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("text/csv");
    const lines = String(dl.body).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("externalOrderId");
    expect(lines[0]).not.toContain("customerEmailHash");
    expect(lines.slice(1).join("\n")).toContain("ORDER-1001");

    // other tenant, affiliate: no access; unknown entity rejected
    const other = await call("/v1/auth/login", { method: "POST", json: { email: "ola@other.co", password: "supersecret1" } });
    expect((await call(`/v1/analytics/exports/${id}`, { token: other.body.token })).status).toBe(404);
    expect((await call(`/v1/analytics/exports/${id}/download`, { token: affiliateToken })).status).toBe(403);
    expect((await call("/v1/analytics/exports", { method: "POST", token: ownerToken, json: { entity: "users" } })).status).toBe(400);
    expect((await call("/v1/analytics/exports", { token: ownerToken })).body.exports.map((e: any) => e.id)).toContain(id);
  });

  it("Assets: merchants can upload files; served with the right type; bad types and sizes rejected", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
    const form = new FormData();
    form.append("file", new File([png], "banner.png", { type: "image/png" }));
    const up = await app.request(BASE + "/v1/assets/upload", { method: "POST", headers: { authorization: `Bearer ${ownerToken}` }, body: form });
    expect(up.status).toBe(201);
    const { file } = await up.json();
    expect(file.key).toMatch(/^tenants\/ten_[A-Za-z0-9]+\/assets\/[a-f0-9]{24}\.png$/);
    expect(file.url).toBe(`${BASE}/files/${file.key}`);
    expect(file.sizeBytes).toBe(png.length);

    const served = await app.request(file.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    expect((await app.request(BASE + "/files/tenants/other/assets/nope.png")).status).toBe(404);
    expect((await app.request(BASE + "/files/../package.json")).status).toBe(404);

    const created = await call("/v1/assets", { method: "POST", token: ownerToken, json: { type: "banner", title: "Uploaded banner", url: file.url, storageKey: file.key, contentType: file.contentType, sizeBytes: file.sizeBytes } });
    expect(created.status).toBe(201);
    expect((await call("/portal/assets", { token: affiliateToken })).body.assets.some((a: any) => a.url === file.url)).toBe(true);

    const bad = new FormData();
    bad.append("file", new File([new Uint8Array([1, 2, 3])], "evil.exe", { type: "application/x-msdownload" }));
    const rejected = await app.request(BASE + "/v1/assets/upload", { method: "POST", headers: { authorization: `Bearer ${ownerToken}` }, body: bad });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.message).toMatch(/unsupported file type/);

    const big = new FormData();
    big.append("file", new File([new Uint8Array(26 * 1024 * 1024)], "big.png", { type: "image/png" }));
    const tooBig = await app.request(BASE + "/v1/assets/upload", { method: "POST", headers: { authorization: `Bearer ${ownerToken}` }, body: big });
    expect(tooBig.status).toBe(400);
    expect((await tooBig.json()).error.message).toMatch(/larger than 25 MB/);

    // affiliates cannot upload
    const asAffiliate = await app.request(BASE + "/v1/assets/upload", { method: "POST", headers: { authorization: `Bearer ${affiliateToken}` }, body: form });
    expect(asAffiliate.status).toBe(403);
  });

  it("Account: verification email on signup, resend, forgot and reset password", async () => {
    email.sent.length = 0;
    const signup = await call("/v1/auth/signup", { method: "POST", json: { name: "Verify Co", slug: "verify-co", owner: { name: "Vee", email: "vee@verify.co", password: "supersecret1" } } });
    expect(signup.body.user.emailVerified).toBe(false);
    await runOnce({ db: handle.db, email, storage, webUrl: "http://web.test", now });
    const mail = email.sent.find((m) => m.to === "vee@verify.co" && m.subject.startsWith("Verify your email"));
    const token = /verify-email\?token=([A-Za-z0-9]+)/.exec(mail!.body)![1]!;
    expect((await call("/v1/auth/verify-email", { method: "POST", json: { token: "bogus-bogus-bogus" } })).status).toBe(400);
    const verified = await call("/v1/auth/verify-email", { method: "POST", json: { token } });
    expect(verified.status).toBe(200);
    expect(verified.body.user.emailVerified).toBe(true);
    expect((await call("/v1/tenant/me", { token: signup.body.token })).body.user.emailVerified).toBe(true);

    expect((await call("/v1/auth/forgot-password", { method: "POST", json: { email: "nobody@verify.co" } })).status).toBe(200);
    await call("/v1/auth/forgot-password", { method: "POST", json: { email: "vee@verify.co" } });
    await runOnce({ db: handle.db, email, storage, webUrl: "http://web.test", now });
    const reset = email.sent.find((m) => m.to === "vee@verify.co" && m.subject === "Reset your password");
    const resetToken = /reset-password\?token=([A-Za-z0-9]+)/.exec(reset!.body)![1]!;
    expect((await call("/v1/auth/reset-password", { method: "POST", json: { token: resetToken, password: "brandnewpass1" } })).status).toBe(200);
    expect((await call("/v1/tenant/me", { token: signup.body.token })).status).toBe(401); // sessions revoked
    expect((await call("/v1/auth/login", { method: "POST", json: { email: "vee@verify.co", password: "brandnewpass1" } })).status).toBe(200);
  });

  it("Rate limiting: public endpoints return 429 after the configured number of requests", async () => {
    const limited = createApp({ db: handle.db, email, storage, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now, rateLimits: { redirect: 2, public: 2, auth: 2 } } });
    const hit = async (path: string, ip: string) => (await limited.request(BASE + path, { headers: { "x-forwarded-for": ip } })).status;
    expect(await hit("/r/nope", "10.0.0.1")).toBe(404);
    expect(await hit("/r/nope", "10.0.0.1")).toBe(404);
    expect(await hit("/r/nope", "10.0.0.1")).toBe(429);
    expect(await hit("/r/nope", "10.0.0.2")).toBe(404); // per IP
    const login = async () => limited.request(BASE + "/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" }, body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }) });
    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(401);
    const blocked = await login();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect((await blocked.json()).error.code).toBe("rate_limited");
  });

  it("Billing: merchants see plan and usage; hard limits return 402 plan_limit", async () => {
    const billing = await call("/v1/tenant/billing", { token: ownerToken });
    expect(billing.status).toBe(200);
    expect(billing.body.plan.id).toBe("starter");
    expect(billing.body.usage.activeAffiliates).toBeGreaterThanOrEqual(1);
    expect(billing.body.limits.activeAffiliates).toBe(25);
    expect(billing.body.plans.map((p: any) => p.id)).toEqual(["starter", "growth", "pro", "enterprise"]);
    expect((await call("/v1/tenant/billing", { token: affiliateToken })).status).toBe(403);
  });

  it("Platform admin: bootstrap, cross-tenant listing, plan and limit changes, suspension", async () => {
    const admin = await withRlsBypass(handle.db, (tx) => platform.ensurePlatformAdmin(tx, { email: "root@platform.test", password: "rootpass123" }, now()));
    expect(admin.role).toBe("platform_admin");
    // merchants cannot reach admin routes
    expect((await call("/admin/overview", { token: ownerToken })).status).toBe(403);

    const login = await call("/v1/auth/login", { method: "POST", json: { email: "root@platform.test", password: "rootpass123" } });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("platform_admin");
    const adminToken = login.body.token;

    const overview = await call("/admin/overview", { token: adminToken });
    expect(overview.status).toBe(200);
    expect(overview.body.tenants.total).toBeGreaterThanOrEqual(2);

    const list = await call("/admin/tenants?q=coach", { token: adminToken });
    const coach = list.body.tenants.find((t: any) => t.tenant.slug === "coach-co");
    expect(coach).toBeTruthy();
    const used: number = coach.activeAffiliates;
    expect(used).toBe((await call("/v1/tenant/billing", { token: ownerToken })).body.usage.activeAffiliates);
    expect(coach.owners[0].email).toBe("priya@coach.co");
    const tenantId = coach.tenant.id;

    // tighten the affiliate limit to what is already used: the next activation is refused with 402
    const patched = await call(`/admin/tenants/${tenantId}`, { method: "PATCH", token: adminToken, json: { planId: "growth", planLimits: { activeAffiliates: used }, reason: "test" } });
    expect(patched.status).toBe(200);
    expect(patched.body.tenant.planId).toBe("growth");
    const detail = await call(`/admin/tenants/${tenantId}`, { token: adminToken });
    expect(detail.body.limits).toMatchObject({ activeAffiliates: used, programs: 5 });
    const invite = await call("/v1/affiliates/invites", { method: "POST", token: ownerToken, json: { programId, email: "extra@partner.io", name: "Extra" } });
    const blocked = await call(`/invite/${invite.body.invite.token}/accept`, { method: "POST", json: { name: "Extra Partner", password: "partnerpass1", acceptTerms: true } });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe("plan_limit");
    expect((await call("/v1/tenant/billing", { token: ownerToken })).body.warnings[0]).toMatchObject({ key: "activeAffiliates", level: "reached" });
    await call(`/admin/tenants/${tenantId}`, { method: "PATCH", token: adminToken, json: { planLimits: null } });

    // suspension locks the workspace out of the API and out of sign-in; reactivation restores it
    await call(`/admin/tenants/${tenantId}`, { method: "PATCH", token: adminToken, json: { status: "suspended", reason: "unpaid" } });
    expect((await call("/v1/offers", { token: ownerToken })).status).toBe(403);
    expect((await call("/v1/auth/login", { method: "POST", json: { email: "priya@coach.co", password: "supersecret1" } })).status).toBe(401);
    await call(`/admin/tenants/${tenantId}`, { method: "PATCH", token: adminToken, json: { status: "active" } });
    expect((await call("/v1/offers", { token: ownerToken })).status).toBe(200);

    // audit trail carries the admin's change
    const audit = await call("/v1/tenant/audit?limit=5", { token: ownerToken });
    expect(audit.body.entries.some((e: any) => e.action === "admin_update" && e.reason === "unpaid")).toBe(true);
    expect((await call("/admin/jobs", { token: adminToken })).status).toBe(200);
  });

  it("Automation: a rule created through the API runs in the worker and leaves a log, a tag and a task", async () => {
    const catalog = await call("/v1/automation/catalog", { token: ownerToken });
    expect(catalog.body.triggers.some((t: any) => t.type === "conversion.created")).toBe(true);
    const created = await call("/v1/automation/rules", { method: "POST", token: ownerToken, json: { name: "Tag any sale", trigger: "conversion.created", conditions: [{ field: "amountMinor", op: "gte", value: 1 }], actions: [{ type: "add_tag", tag: "seller" }, { type: "create_task", title: "Say thanks to {{affiliate_name}}" }] } });
    expect(created.status).toBe(201);
    const ruleId = created.body.rule.id;
    // manual attribution: the clock has moved past the click window by this point in the suite
    const sale = await call("/v1/conversions", { method: "POST", token: ownerToken, json: { source: "manual", externalOrderId: "ORDER-AUTO-1", offerId, amountMinor: 12_000, affiliateId, programId, reason: "phone order" } });
    expect(sale.status).toBe(201);
    expect(sale.body.conversion.affiliateId).toBe(affiliateId);
    await runOnce({ db: handle.db, email, storage, webUrl: "http://web.test", now });
    const runs = await call(`/v1/automation/rules/${ruleId}/runs`, { token: ownerToken });
    const hit = runs.body.runs.find((r: any) => r.entityId === sale.body.conversion.id);
    expect(hit?.error ?? null).toBeNull();
    expect(hit).toMatchObject({ status: "success", matched: true });
    expect((await call(`/v1/affiliates/${affiliateId}`, { token: ownerToken })).body.affiliate.tags).toContain("seller");
    const tasks = await call("/v1/automation/tasks?status=open", { token: ownerToken });
    expect(tasks.body.tasks.some((t: any) => t.title === "Say thanks to Sam Partner")).toBe(true);
    const done = await call(`/v1/automation/tasks/${tasks.body.tasks[0].id}/done`, { method: "POST", token: ownerToken });
    expect(done.body.task.status).toBe("done");
    expect((await call(`/v1/automation/rules/${ruleId}/enabled`, { method: "POST", token: ownerToken, json: { enabled: false } })).body.rule.enabled).toBe(false);
    expect((await call("/v1/automation/rules", { token: affiliateToken })).status).toBe(403);
  });

  it("Groups and tiers: a group tier changes the commission and the portal shows the effective rate", async () => {
    const group = await call("/v1/groups", { method: "POST", token: ownerToken, json: { name: "Alumni", kind: "partner_type" } });
    expect(group.status).toBe(201);
    expect((await call(`/v1/groups/${group.body.group.id}/members`, { method: "POST", token: ownerToken, json: { affiliateIds: [affiliateId] } })).status).toBe(201);
    const tier = await call(`/v1/programs/${programId}/tiers`, { method: "POST", token: ownerToken, json: { name: "Alumni rate", kind: "group", groupId: group.body.group.id, commissionPercent: 25 } });
    expect(tier.status).toBe(201);
    const sale = await call("/v1/conversions", { method: "POST", token: ownerToken, json: { source: "manual", externalOrderId: "ORDER-TIER-1", offerId, amountMinor: 100_000, affiliateId, programId, reason: "phone order" } });
    expect(sale.body.commission).toMatchObject({ amountMinor: 25_000 });
    expect(sale.body.commission.calculationBasis).toMatchObject({ overrideSource: "tier", tierName: "Alumni rate" });
    const portal = await call("/portal/offers", { token: affiliateToken });
    expect(portal.body.programs[0].effective).toMatchObject({ percent: 25, source: "tier", tierName: "Alumni rate" });
    expect((await call(`/v1/affiliates/${affiliateId}`, { token: ownerToken })).body.groups.map((g: any) => g.name)).toEqual(["Alumni"]);
    expect((await call(`/v1/groups/${group.body.group.id}`, { method: "DELETE", token: ownerToken })).status).toBe(409);
    expect((await call("/v1/groups", { token: affiliateToken })).status).toBe(403);
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
