import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, messaging, type DbHandle } from "@referly/core";
import { createApp, type App } from "../src/app";
import { resetRateLimits } from "../src/lib/ratelimit";
import { LocalStorage } from "../src/storage";
import { createLogger } from "../src/lib/log";
import { SNIPPET_JS } from "../src/snippet";

/**
 * Website tracking over HTTP (TRK-09): the served snippet, settings endpoints, the public
 * events endpoint (text/plain bodies, CORS, origin rules, no affiliate leakage), snippet-reported
 * orders (off by default, idempotent, attributed), and the merchant's journey views.
 */
let handle: DbHandle;
let app: App;
const clock = new Date("2026-08-01T10:00:00Z");
const now = () => new Date(clock);
const email = new messaging.MemoryEmailProvider();
const quiet = createLogger({ level: "error", write: () => {} });
const BASE = "http://api.test";

beforeAll(async () => {
  handle = await createTestDb();
  const storage = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-journeys-")), BASE);
  app = createApp({ db: handle.db, email, storage, log: quiet, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
  resetRateLimits();
});
afterAll(() => handle.close());

async function call<T = any>(p: string, init: RequestInit & { token?: string; json?: unknown; text?: string } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.text !== undefined) headers.set("content-type", "text/plain");
  const res = await app.request(BASE + p, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : (init.text ?? init.body), redirect: "manual" });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

/** What the snippet sends: a JSON string with a text/plain content type (no preflight, beacon-compatible). */
const beacon = (p: string, payload: unknown, origin = "https://shop.acme.test") => call(p, { method: "POST", text: JSON.stringify(payload), headers: { origin } });

describe("website tracking over HTTP", () => {
  let ownerToken: string;
  let marketingToken: string;
  let apiKey: string;
  let offerId: string;
  let programId: string;
  let affiliateId: string;
  let affiliateToken: string;
  let siteKey: string;
  let clickToken: string;
  const visitor = "v_browser_visitor_1";

  it("serves the snippet as cacheable JavaScript, and tracking is off until an owner turns it on", async () => {
    const js = await app.request(`${BASE}/referly.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("application/javascript");
    expect(js.headers.get("cache-control")).toContain("max-age=3600");
    const text = await js.text();
    expect(text).toBe(SNIPPET_JS);
    expect(text).toContain("/t/");
    expect(text).toContain("referly_ref");
    expect(text).not.toContain("${");

    const signup = await call("/v1/auth/signup", { method: "POST", json: { name: "Acme Shop", slug: "acme-shop", currency: "USD", owner: { name: "Ann", email: "ann@acme.test", password: "supersecret1" } } });
    ownerToken = signup.body.token;
    const member = await call("/v1/tenant/team", { method: "POST", token: ownerToken, json: { name: "Mia", email: "mia@acme.test", password: "supersecret1", role: "marketing" } });
    expect(member.status).toBe(201);
    marketingToken = (await call("/v1/auth/login", { method: "POST", json: { email: "mia@acme.test", password: "supersecret1" } })).body.token;
    const offer = await call("/v1/offers", { method: "POST", token: ownerToken, json: { name: "Course", priceMinor: 12_900, salesUrl: "https://shop.acme.test/course" } });
    offerId = offer.body.offer.id;
    await call(`/v1/offers/${offerId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const program = await call("/v1/programs", { method: "POST", token: ownerToken, json: { name: "Partners", commissionModel: "percentage", commissionPercent: 10, holdingDays: 0, attributionWindowDays: 30, refundPolicy: "full", offerIds: [offerId], approvalMode: "auto", termsText: "Be nice." } });
    programId = program.body.program.id;
    await call(`/v1/programs/${programId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    apiKey = (await call("/v1/tenant/api-keys", { method: "POST", token: ownerToken, json: { name: "checkout", scopes: ["conversions.write", "read"] } })).body.secret;
    const invite = await call("/v1/affiliates/invites", { method: "POST", token: ownerToken, json: { programId, email: "pat@partner.io", name: "Pat" } });
    const accept = await call(`/invite/${invite.body.invite.token}/accept`, { method: "POST", json: { name: "Pat Partner", password: "partnerpass1", acceptTerms: true } });
    affiliateId = accept.body.affiliate.id;
    affiliateToken = accept.body.token;
    const link = await call("/portal/links", { method: "POST", token: affiliateToken, json: { programId, offerId } });
    const redirect = await app.request(`${BASE}/r/${link.body.link.token}`, { redirect: "manual" });
    clickToken = new URL(redirect.headers.get("location")!).searchParams.get("ref")!;

    const off = await call("/v1/tenant/tracking", { token: ownerToken });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, siteKey: null, install: null, scriptUrl: `${BASE}/referly.js` });
    expect((await call("/v1/tenant/tracking/enable", { method: "POST", token: marketingToken })).status).toBe(403);
    const on = await call("/v1/tenant/tracking/enable", { method: "POST", token: ownerToken });
    expect(on.status).toBe(200);
    siteKey = on.body.siteKey;
    expect(siteKey).toMatch(/^site_/);
    expect(on.body.install).toBe(`<script>window.referly=window.referly||function(){(window.referly.q=window.referly.q||[]).push(arguments)};</script>\n<script async src="${BASE}/referly.js" data-site="${siteKey}"></script>`);
    expect(on.body.examples.convert).toContain("referly('convert'");
  });

  it("the events endpoint answers the preflight for any origin, takes a text/plain JSON body, ties events to the affiliate and returns only the cookie ttl", async () => {
    const preflight = await app.request(`${BASE}/t/${siteKey}/events`, { method: "OPTIONS", headers: { origin: "https://shop.acme.test", "access-control-request-method": "POST" } });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    const res = await beacon(`/t/${siteKey}/events`, {
      visitorId: visitor,
      sessionId: "s_browser_session1",
      ref: clickToken,
      events: [
        { type: "page_view", url: `https://shop.acme.test/course?ref=${clickToken}`, title: "Course", referrer: "https://pat.blog/review", at: clock.getTime() - 60_000 },
        { type: "event", name: "add_to_cart", url: "https://shop.acme.test/course", properties: { sku: "COURSE" }, at: clock.getTime() - 55_000 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 2, ref: { ttlSeconds: 30 * 86_400 } });
    expect(JSON.stringify(res.body)).not.toContain(affiliateId);

    expect((await beacon(`/t/site_000000000000000000000000/events`, { visitorId: visitor, sessionId: "s_browser_session1", events: [{ type: "page_view" }] })).status).toBe(404);
    expect((await call(`/t/${siteKey}/events`, { method: "POST", text: "not json", headers: { origin: "https://shop.acme.test" } })).status).toBe(400);
    expect((await beacon(`/t/${siteKey}/events`, { visitorId: "x", sessionId: "y", events: [] })).status).toBe(400);

    const view = await call("/v1/tenant/tracking", { token: ownerToken });
    expect(view.body).toMatchObject({ enabled: true, events7d: 2, visitors7d: 1, lastEventHost: "shop.acme.test" });
  });

  it("once domains are set, other origins and non-browser requests are refused with the same 404", async () => {
    const bad = await call("/v1/tenant/tracking", { method: "PATCH", token: ownerToken, json: { pixelConversions: true } });
    expect(bad.status).toBe(400);
    const saved = await call("/v1/tenant/tracking", { method: "PATCH", token: ownerToken, json: { domains: ["shop.acme.test"], pixelConversions: true } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ domains: ["shop.acme.test"], pixelConversions: true });
    const batch = { visitorId: visitor, sessionId: "s_browser_session1", events: [{ type: "page_view", url: "https://shop.acme.test/pricing" }] };
    expect((await beacon(`/t/${siteKey}/events`, batch, "https://evil.test")).status).toBe(404);
    expect((await call(`/t/${siteKey}/events`, { method: "POST", text: JSON.stringify(batch) })).status).toBe(404);
    expect((await beacon(`/t/${siteKey}/events`, batch, "https://www.shop.acme.test")).status).toBe(200);
    expect((await call(`/v1/tenant/tracking`, { method: "PATCH", token: marketingToken, json: { domains: [] } })).status).toBe(403);
  });

  it("an order reported by the snippet is recorded as a pixel sale, attributed through the visitor, idempotent, and shows on the journey; the delivery is logged", async () => {
    const order = { visitorId: visitor, sessionId: "s_browser_session1", orderId: "WEB-1", amount: 129, currency: "usd", email: "buyer@example.com", url: "https://shop.acme.test/thanks?order=WEB-1" };
    const first = await beacon(`/t/${siteKey}/convert`, order);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ok: true, conversionId: expect.stringMatching(/^cnv_/), duplicate: false, attributed: true });
    const again = await beacon(`/t/${siteKey}/convert`, order);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ conversionId: first.body.conversionId, duplicate: true });
    const detail = await call(`/v1/conversions/${first.body.conversionId}`, { token: ownerToken });
    expect(detail.body.conversion).toMatchObject({ source: "pixel", kind: "sale", amountMinor: 12_900, currency: "USD", affiliateId, attributionSource: "link", customerRef: null });
    expect(detail.body.conversion.customerEmailHash).toBeTruthy();
    expect(detail.body.commission.amountMinor).toBe(1_290);
    const journey = await call(`/v1/conversions/${first.body.conversionId}/journey`, { token: ownerToken });
    expect(journey.body.visitorId).toBe(visitor);
    expect(journey.body.events.map((e: any) => e.type)).toEqual(["page_view", "event", "page_view", "conversion"]);
    expect(journey.body.events.at(-1)).toMatchObject({ name: "WEB-1", conversionId: first.body.conversionId, path: "/thanks?order=WEB-1" });
    // minor units and a zero-decimal currency are accepted too; a bad body is a 400 and logged as failed
    expect((await beacon(`/t/${siteKey}/convert`, { ...order, orderId: "WEB-2", amount: undefined, amountMinor: 5_000 })).body).toMatchObject({ duplicate: false });
    expect((await beacon(`/t/${siteKey}/convert`, { ...order, orderId: "WEB-3", amount: 1500, currency: "JPY" })).status).toBe(201);
    const jpy = await call(`/v1/conversions?limit=5`, { token: ownerToken });
    expect(jpy.body.conversions.find((c: any) => c.externalOrderId === "WEB-3")).toMatchObject({ amountMinor: 1500, currency: "JPY" });
    expect((await beacon(`/t/${siteKey}/convert`, { visitorId: visitor, orderId: "" })).status).toBe(400);
    // an order id cannot be used to smuggle a lead or a manual attribution
    const smuggle = await beacon(`/t/${siteKey}/convert`, { ...order, orderId: "WEB-4", kind: "lead", affiliateId: "aff_x", reason: "x", source: "manual" });
    expect(smuggle.status).toBe(201);
    const smuggled = (await call(`/v1/conversions?limit=10`, { token: ownerToken })).body.conversions.find((c: any) => c.externalOrderId === "WEB-4");
    expect(smuggled).toMatchObject({ source: "pixel", kind: "sale", affiliateId });
  });

  it("snippet-reported orders are refused when the workspace turns them off, while events keep flowing", async () => {
    await call("/v1/tenant/tracking", { method: "PATCH", token: ownerToken, json: { pixelConversions: false } });
    expect((await beacon(`/t/${siteKey}/convert`, { visitorId: visitor, orderId: "WEB-9", amount: 10 })).status).toBe(404);
    expect((await beacon(`/t/${siteKey}/events`, { visitorId: visitor, sessionId: "s_browser_session2", events: [{ type: "page_view", url: "https://shop.acme.test/" }] })).status).toBe(200);
  });

  it("a server-side post from the checkout with the visitor id (no cookie, no ref) is attributed through the recorded journey", async () => {
    const res = await call("/v1/conversions", { method: "POST", token: apiKey, json: { externalOrderId: "SRV-1", offerId, amountMinor: 20_000, visitorId: visitor } });
    expect(res.status).toBe(201);
    expect(res.body.conversion.affiliateId).toBe(affiliateId);
    expect(res.body.attribution.ruleApplied).toBe("last_click");
    expect((await call("/v1/conversions", { method: "POST", token: apiKey, json: { externalOrderId: "SRV-2", offerId, amountMinor: 20_000, visitorId: "bad id!" } })).status).toBe(400);
  });

  it("the journeys page lists visits with outcome and affiliate, filters, summarises, and opens a visitor's full journey; affiliates are refused", async () => {
    const session = await call(`/v1/journeys/sessions/${visitor}/s_browser_session1`, { token: ownerToken });
    expect(session.body.events.map((e: any) => `${e.type}:${e.name ?? e.path}`)).toEqual([`page_view:/course?ref=${clickToken}`, "event:add_to_cart", "page_view:/pricing", "conversion:WEB-1", "conversion:WEB-2", "conversion:WEB-3", "conversion:WEB-4"]);
    const list = await call("/v1/journeys?days=30", { token: ownerToken });
    expect(list.status).toBe(200);
    // the server-side sale (SRV-1) landed on the visitor's newer session, so both visits converted
    expect(list.body.summary).toEqual({ sessions: 2, attributedSessions: 2, convertedSessions: 2, pageViews: 3 });
    const first = list.body.sessions.find((s: any) => s.sessionId === "s_browser_session1");
    expect(first).toMatchObject({ visitorId: visitor, affiliateId, affiliateName: "Pat Partner", pages: 2, events: 1, conversions: 4, outcome: "converted", landingPath: `/course?ref=${clickToken}`, referrer: "https://pat.blog/review" });
    expect((await call("/v1/journeys?converted=1", { token: ownerToken })).body.sessions.map((s: any) => s.sessionId).sort()).toEqual(["s_browser_session1", "s_browser_session2"]);
    const second = list.body.sessions.find((s: any) => s.sessionId === "s_browser_session2");
    expect(second).toMatchObject({ pages: 1, conversions: 1, outcome: "converted" });
    expect((await call(`/v1/journeys?affiliateId=${affiliateId}`, { token: ownerToken })).body.sessions.length).toBe(2);
    expect((await call(`/v1/journeys?affiliateId=aff_nobody`, { token: ownerToken })).body.sessions.length).toBe(0);
    const all = await call(`/v1/journeys/visitors/${visitor}`, { token: ownerToken });
    expect(all.body.events.length).toBe(9);
    expect((await call("/v1/journeys", { token: marketingToken })).status).toBe(200);
    expect((await call("/v1/journeys", { token: apiKey })).status).toBe(200); // read scope covers reporting
    expect((await call("/v1/journeys", { token: affiliateToken })).status).toBe(403);
    expect((await call("/v1/tenant/tracking", { token: affiliateToken })).status).toBe(403);
  });

  it("another workspace's site key never sees these journeys, and rotating the key invalidates the old snippet", async () => {
    const other = await call("/v1/auth/signup", { method: "POST", json: { name: "Other", slug: "other-shop", currency: "USD", owner: { name: "Bo", email: "bo@other.test", password: "supersecret1" } } });
    const enabled = await call("/v1/tenant/tracking/enable", { method: "POST", token: other.body.token });
    const otherKey = enabled.body.siteKey;
    const res = await beacon(`/t/${otherKey}/events`, { visitorId: visitor, sessionId: "s_browser_session1", ref: clickToken, events: [{ type: "page_view", url: "https://other.test/" }] });
    expect(res.body).toEqual({ ok: true, accepted: 1, ref: null }); // the click belongs to Acme: not resolvable here
    expect((await call("/v1/journeys?attributed=0", { token: other.body.token })).body.sessions[0]).toMatchObject({ affiliateId: null, pages: 1 });
    expect((await call("/v1/journeys", { token: ownerToken })).body.summary.sessions).toBe(2);
    const rotated = await call("/v1/tenant/tracking/rotate", { method: "POST", token: ownerToken });
    expect(rotated.body.siteKey).not.toBe(siteKey);
    expect((await beacon(`/t/${siteKey}/events`, { visitorId: visitor, sessionId: "s_browser_session2", events: [{ type: "page_view" }] })).status).toBe(404);
    expect((await beacon(`/t/${rotated.body.siteKey}/events`, { visitorId: visitor, sessionId: "s_browser_session2", events: [{ type: "page_view" }] })).status).toBe(200);
  });
});
