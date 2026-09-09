import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, messaging, type DbHandle } from "@referly/core";
import { createApp, type App } from "../src/app";
import { runOnce } from "../src/worker";
import { resetRateLimits } from "../src/lib/ratelimit";
import { LocalStorage } from "../src/storage";
import { createLogger } from "../src/lib/log";

/**
 * Leads over HTTP: program lead terms and capture URL, the public capture endpoint (JSON and
 * form posts, redirect, CORS, dedupe), API-key intake, the review queue, qualification and its
 * effect on the commission, notifications and emails, and the portal view without contact data.
 */
let handle: DbHandle;
let app: App;
let clock = new Date("2026-07-01T10:00:00Z");
const now = () => new Date(clock);
const email = new messaging.MemoryEmailProvider();
const quiet = createLogger({ level: "error", write: () => {} });
const BASE = "http://api.test";
let storage: LocalStorage;
const workerDeps = () => ({ db: handle.db, email, storage, webUrl: "http://web.test", now, log: quiet });

beforeAll(async () => {
  handle = await createTestDb();
  storage = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-leads-")), BASE);
  app = createApp({ db: handle.db, email, storage, log: quiet, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
  resetRateLimits();
});
afterAll(() => handle.close());

async function call<T = any>(p: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await app.request(BASE + p, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, redirect: "manual" });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

describe("leads over HTTP", () => {
  let ownerToken: string;
  let affiliateToken: string;
  let affiliateId: string;
  let apiKey: string;
  let programId: string;
  let offerId: string;
  let captureUrl: string;
  let clickToken: string;
  let firstLeadId: string;

  it("a program with leads enabled exposes a capture URL; the conversion endpoint still records sales only", async () => {
    const signup = await call("/v1/auth/signup", { method: "POST", json: { name: "Lead Co", slug: "lead-co", currency: "USD", owner: { name: "Lou", email: "lou@lead.co", password: "supersecret1" } } });
    ownerToken = signup.body.token;
    const offer = await call("/v1/offers", { method: "POST", token: ownerToken, json: { name: "Consultation", priceMinor: 0, salesUrl: "https://lead.co/book" } });
    offerId = offer.body.offer.id;
    await call(`/v1/offers/${offerId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const program = await call("/v1/programs", { method: "POST", token: ownerToken, json: { name: "Referrers", commissionModel: "fixed", commissionFixedMinor: 5_000, holdingDays: 0, attributionWindowDays: 30, refundPolicy: "full", offerIds: [offerId], approvalMode: "auto", termsText: "Be nice.", leadsEnabled: true, leadCommissionMinor: 2_500, leadApproval: "manual", leadDedupeDays: 30 } });
    expect(program.status).toBe(201);
    programId = program.body.program.id;
    expect(program.body.program.leadCaptureToken).toBeTruthy();
    await call(`/v1/programs/${programId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const detail = await call(`/v1/programs/${programId}`, { token: ownerToken });
    captureUrl = detail.body.captureUrl;
    expect(captureUrl).toBe(`${BASE}/capture/${program.body.program.leadCaptureToken}`);
    const key = await call("/v1/tenant/api-keys", { method: "POST", token: ownerToken, json: { name: "crm", scopes: ["conversions.write", "read"] } });
    apiKey = key.body.secret;
    const invite = await call("/v1/affiliates/invites", { method: "POST", token: ownerToken, json: { programId, email: "ref@partner.io", name: "Ref" } });
    const accept = await call(`/invite/${invite.body.invite.token}/accept`, { method: "POST", json: { name: "Ref Partner", password: "partnerpass1", acceptTerms: true } });
    affiliateToken = accept.body.token;
    affiliateId = accept.body.affiliate.id;
    await runOnce(workerDeps());
    const link = await call("/portal/links", { method: "POST", token: affiliateToken, json: { programId, offerId } });
    const redirect = await app.request(`${BASE}/r/${link.body.link.token}`, { redirect: "manual" });
    clickToken = new URL(redirect.headers.get("location")!).searchParams.get("ref")!;
    expect(clickToken).toBeTruthy();
    // a kind of lead cannot be smuggled through the sales endpoint
    const smuggled = await call("/v1/conversions", { method: "POST", token: apiKey, json: { externalOrderId: "s-1", offerId, amountMinor: 100, kind: "lead" } });
    expect(smuggled.status).toBe(201);
    expect(smuggled.body.conversion.kind).toBe("sale");
  });

  it("the public capture endpoint takes a JSON post from any origin, attributes by the forwarded click token, and never echoes the contact", async () => {
    const preflight = await app.request(captureUrl, { method: "OPTIONS", headers: { origin: "https://lead.co", "access-control-request-method": "POST" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const res = await call(captureUrl.slice(BASE.length), { method: "POST", json: { name: "Lena", email: "Lena@Example.com", phone: "+15550001", ref: clickToken, budget: "2k", nested: { no: 1 } }, headers: { origin: "https://lead.co" } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, leadId: expect.stringMatching(/^lead_/), duplicate: false });
    expect(JSON.stringify(res.body)).not.toContain("Lena");
    firstLeadId = res.body.leadId;
    expect((await call("/capture/not-a-token", { method: "POST", json: { email: "x@y.z" } })).status).toBe(404);
    expect((await call(captureUrl.slice(BASE.length), { method: "POST", json: { budget: "no contact" } })).status).toBe(400);

    await runOnce(workerDeps());
    const queue = await call("/v1/leads?disposition=pending", { token: ownerToken });
    expect(queue.status).toBe(200);
    expect(queue.body.summary).toEqual({ pending: 1, qualified: 0, disqualified: 0, duplicate: 0 });
    const row = queue.body.leads[0];
    expect(row.lead).toMatchObject({ id: firstLeadId, name: "Lena", email: "lena@example.com", phone: "+15550001", fields: { budget: "2k" }, affiliateId, programId });
    expect(row.affiliateName).toBe("Ref Partner");
    expect(row.commissionMinor).toBe(2_500);
    expect(row.commissionStatus).toBe("pending");
    // notifications and email went out
    const owner = await call("/v1/notifications?unread=1", { token: ownerToken });
    expect(owner.body.notifications.some((n: any) => n.category === "leads" && n.title === "New lead via Ref Partner" && n.link === "/app/leads")).toBe(true);
    const mine = await call("/portal/notifications?unread=1", { token: affiliateToken });
    expect(mine.body.notifications.some((n: any) => n.title === "A lead was attributed to you" && n.link === "/portal/leads")).toBe(true);
    const mail = email.sent.find((m) => m.to === "ref@partner.io" && m.subject === "New lead attributed to you");
    expect(mail?.body).toContain("25.00 USD");
    expect(mail?.body).toContain("Referrers");
  });

  it("a form-encoded post with a redirect lands on the thank-you page; the same email inside the dedupe window is a duplicate", async () => {
    const form = new URLSearchParams({ name: "Lena again", email: "lena@example.com", ref: clickToken, redirect: "https://lead.co/thanks" });
    const res = await app.request(captureUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://lead.co/thanks");
    const bad = new URLSearchParams({ email: "other@example.com", redirect: "javascript:alert(1)" });
    expect((await app.request(captureUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: bad.toString() })).status).toBe(400);
    const dupes = await call("/v1/leads?disposition=duplicate", { token: ownerToken });
    expect(dupes.body.leads).toHaveLength(1);
    expect(dupes.body.leads[0].lead.dispositionNote).toContain(firstLeadId);
    expect(dupes.body.leads[0].commissionMinor).toBeNull();
  });

  it("API keys record leads with their own ids (idempotent); qualifying approves the commission; disqualifying voids it", async () => {
    const one = await call("/v1/leads", { method: "POST", token: apiKey, json: { externalLeadId: "crm-1", email: "api@example.com", name: "Api Lead", clickToken } });
    expect(one.status).toBe(201);
    expect(one.body.commissionMinor).toBe(2_500);
    const again = await call("/v1/leads", { method: "POST", token: apiKey, json: { externalLeadId: "crm-1", email: "api@example.com", clickToken } });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.lead.id).toBe(one.body.lead.id);
    // read-only key cannot record
    const ro = await call("/v1/tenant/api-keys", { method: "POST", token: ownerToken, json: { name: "ro", scopes: ["read"] } });
    expect((await call("/v1/leads", { method: "POST", token: ro.body.secret, json: { email: "ro@example.com" } })).status).toBe(403);

    const q = await call(`/v1/leads/${firstLeadId}/qualify`, { method: "POST", token: ownerToken, json: { note: "spoke on the phone" } });
    expect(q.status).toBe(200);
    expect(q.body.lead.disposition).toBe("qualified");
    const detail = await call(`/v1/leads/${firstLeadId}`, { token: ownerToken });
    const commissions = await call(`/v1/commissions?affiliateId=${affiliateId}`, { token: ownerToken });
    const leadCommission = commissions.body.commissions.find((c: any) => c.conversionId === detail.body.lead.conversionId && c.status !== "void");
    expect(["approved", "payable"]).toContain(leadCommission.status);

    expect((await call(`/v1/leads/${one.body.lead.id}/disqualify`, { method: "POST", token: ownerToken, json: {} })).status).toBe(400);
    const dq = await call(`/v1/leads/${one.body.lead.id}/disqualify`, { method: "POST", token: ownerToken, json: { note: "test entry" } });
    expect(dq.body.lead.disposition).toBe("disqualified");
    const after = await call("/v1/leads", { token: ownerToken });
    expect(after.body.summary).toEqual({ pending: 0, qualified: 1, disqualified: 1, duplicate: 1 });
    expect((await call(`/v1/leads/${firstLeadId}`, { token: affiliateToken })).status).toBe(403);
  });

  it("the portal lists the affiliate's leads without contact details; sales views stay sales-only", async () => {
    const mine = await call("/portal/leads", { token: affiliateToken });
    expect(mine.status).toBe(200);
    expect(mine.body.leads.length).toBe(3);
    for (const l of mine.body.leads) {
      expect(l).not.toHaveProperty("email");
      expect(l).not.toHaveProperty("name");
      expect(l.emailDomain).toBe("example.com");
    }
    expect(mine.body.leads.map((l: any) => l.status).sort()).toEqual(["disqualified", "duplicate", "qualified"]);
    const sales = await call("/portal/conversions", { token: affiliateToken });
    expect(sales.body.conversions.every((c: any) => c.kind === "sale")).toBe(true);
    const merchantSales = await call("/v1/conversions", { token: ownerToken });
    expect(merchantSales.body.conversions.every((c: any) => c.kind === "sale")).toBe(true);
    const overview = await call("/v1/analytics/overview?range=30d", { token: ownerToken });
    expect(overview.status).toBe(200);
  });
});
