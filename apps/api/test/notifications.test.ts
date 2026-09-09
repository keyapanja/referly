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
 * Notification centre over HTTP: the worker fans domain events out to team members and
 * affiliates, both sides list and mark read through their own endpoints, preferences switch
 * categories off, and an affiliate's email preference silences the matching built-in email.
 */
let handle: DbHandle;
let app: App;
let clock = new Date("2026-06-01T10:00:00Z");
const now = () => new Date(clock);
const email = new messaging.MemoryEmailProvider();
const quiet = createLogger({ level: "error", write: () => {} });
const BASE = "http://api.test";
let storage: LocalStorage;
const workerDeps = () => ({ db: handle.db, email, storage, webUrl: "http://web.test", now, log: quiet });

beforeAll(async () => {
  handle = await createTestDb();
  storage = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-ntf-")), BASE);
  app = createApp({ db: handle.db, email, storage, log: quiet, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
  resetRateLimits();
});
afterAll(() => handle.close());

async function call<T = any>(p: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await app.request(BASE + p, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

describe("notification centre over HTTP", () => {
  let ownerToken: string;
  let affiliateToken: string;
  let affiliateId: string;
  let apiKey: string;
  let offerId: string;
  let programId: string;

  it("an invited affiliate who accepts gets an account notification; the owner sees nothing yet", async () => {
    const signup = await call("/v1/auth/signup", { method: "POST", json: { name: "Notify Co", slug: "notify-co", currency: "USD", owner: { name: "Nora", email: "nora@notify.co", password: "supersecret1" } } });
    ownerToken = signup.body.token;
    const offer = await call("/v1/offers", { method: "POST", token: ownerToken, json: { name: "Course", priceMinor: 20_000, salesUrl: "https://notify.co/course" } });
    offerId = offer.body.offer.id;
    await call(`/v1/offers/${offerId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const program = await call("/v1/programs", { method: "POST", token: ownerToken, json: { name: "Partners", commissionModel: "percentage", commissionPercent: 10, holdingDays: 0, attributionWindowDays: 30, refundPolicy: "full", offerIds: [offerId], approvalMode: "auto", termsText: "Be nice." } });
    programId = program.body.program.id;
    await call(`/v1/programs/${programId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const key = await call("/v1/tenant/api-keys", { method: "POST", token: ownerToken, json: { name: "checkout", scopes: ["conversions.write", "read"] } });
    apiKey = key.body.secret;
    const invite = await call("/v1/affiliates/invites", { method: "POST", token: ownerToken, json: { programId: program.body.program.id, email: "pia@partner.io", name: "Pia" } });
    const accept = await call(`/invite/${invite.body.invite.token}/accept`, { method: "POST", json: { name: "Pia Partner", password: "partnerpass1", acceptTerms: true } });
    affiliateToken = accept.body.token;
    affiliateId = accept.body.affiliate.id;
    await runOnce(workerDeps());

    const mine = await call("/portal/notifications", { token: affiliateToken });
    expect(mine.status).toBe(200);
    expect(mine.body.unread).toBe(1);
    expect(mine.body.notifications[0]).toMatchObject({ category: "account", type: "affiliate.approved", link: "/portal/links" });
    expect((await call("/v1/notifications/unread-count", { token: ownerToken })).body.unread).toBe(0);
    // an API key has no inbox; an affiliate cannot use the merchant endpoint and vice versa
    expect((await call("/v1/notifications", { token: apiKey })).status).toBe(403);
    expect((await call("/v1/notifications", { token: affiliateToken })).status).toBe(403);
    expect((await call("/portal/notifications", { token: ownerToken })).status).toBe(403);
  });

  it("a sale through the API key notifies the owner and the affiliate; opening one marks it read", async () => {
    const sale = await call("/v1/conversions", { method: "POST", token: apiKey, json: { source: "webhook", externalOrderId: "n-1", offerId, amountMinor: 30_000, currency: "USD", customerRef: "c1" } });
    expect(sale.status).toBe(201);
    // no click, so unattributed: the team hears about it, the affiliate does not
    await runOnce(workerDeps());
    const owner = await call("/v1/notifications?unread=1", { token: ownerToken });
    expect(owner.body.notifications.map((n: any) => n.title)).toContain("Unattributed sale recorded");
    expect((await call("/portal/notifications/unread-count", { token: affiliateToken })).body.unread).toBe(1);

    const read = await call("/v1/notifications/read", { method: "POST", token: ownerToken, json: { ids: [owner.body.notifications[0].id] } });
    expect(read.body).toEqual({ marked: 1, unread: owner.body.unread - 1 });
    const all = await call("/v1/notifications", { token: ownerToken });
    expect(all.body.notifications.find((n: any) => n.id === owner.body.notifications[0].id).readAt).toBeTruthy();
    expect((await call("/v1/notifications/read", { method: "POST", token: ownerToken, json: { all: true } })).body.unread).toBe(0);
  });

  it("preferences: switching a category off stops the feed and, for affiliates, the matching email", async () => {
    const prefs = await call("/portal/notifications/preferences", { token: affiliateToken });
    expect(prefs.status).toBe(200);
    expect(prefs.body.audience).toBe("affiliate");
    expect(prefs.body.categories.map((c: any) => c.key)).toContain("earnings");
    const updated = await call("/portal/notifications/preferences", { method: "PATCH", token: affiliateToken, json: { earnings: { inApp: false, email: false }, applications: { inApp: false } } });
    expect(updated.body.prefs).toEqual({ earnings: { inApp: false, email: false } });
    expect((await call("/portal/notifications/preferences", { method: "PATCH", token: affiliateToken, json: { earnings: "no" } })).status).toBe(400);

    // an attributed sale: click → conversion
    const link = await call("/portal/links", { method: "POST", token: affiliateToken, json: { programId, offerId } });
    expect(link.status).toBe(201);
    const redirect = await app.request(`${BASE}/r/${link.body.link.token}`, { redirect: "manual" });
    const clickToken = new URL(redirect.headers.get("location")!).searchParams.get("ref");
    expect(clickToken).toBeTruthy();
    const sentBefore = email.sent.length;
    const sale = await call("/v1/conversions", { method: "POST", token: apiKey, json: { source: "webhook", externalOrderId: "n-2", offerId, amountMinor: 40_000, currency: "USD", clickToken } });
    expect(sale.body.commission).toBeTruthy();
    await runOnce(workerDeps());
    const mine = await call("/portal/notifications?unread=1", { token: affiliateToken });
    expect(mine.body.notifications.some((n: any) => n.type === "conversion.created")).toBe(false);
    expect(email.sent.slice(sentBefore).some((m) => m.to === "pia@partner.io")).toBe(false);
    // the owner still gets the sale
    expect((await call("/v1/notifications?unread=1", { token: ownerToken })).body.notifications.some((n: any) => n.title === "Sale attributed to Pia Partner")).toBe(true);

    // back on: the next commission event reaches both channels
    await call("/portal/notifications/preferences", { method: "PATCH", token: affiliateToken, json: { earnings: { inApp: true, email: true } } });
    const reverse = await call(`/v1/commissions/${sale.body.commission.id}/reverse`, { method: "POST", token: ownerToken, json: { reason: "test" } });
    expect(reverse.status).toBe(200);
    await runOnce(workerDeps());
    expect((await call("/portal/notifications?unread=1", { token: affiliateToken })).body.notifications.some((n: any) => n.type === "commission.reversed")).toBe(true);
    expect(email.sent.some((m) => m.to === "pia@partner.io" && /reversed/i.test(m.body))).toBe(true);
  });

  it("merchant preferences list only the caller's categories and are per user", async () => {
    const member = await call("/v1/tenant/team", { method: "POST", token: ownerToken, json: { name: "Max", email: "max@notify.co", role: "marketing", password: "marketing123" } });
    expect(member.status).toBe(201);
    const maxToken = (await call("/v1/auth/login", { method: "POST", json: { email: "max@notify.co", password: "marketing123" } })).body.token;
    const prefs = await call("/v1/notifications/preferences", { token: maxToken });
    expect(prefs.body.categories.map((c: any) => c.key)).toEqual(["applications", "sales", "leads", "tasks"]);
    await call("/v1/notifications/preferences", { method: "PATCH", token: maxToken, json: { sales: { inApp: false } } });
    expect((await call("/v1/notifications/preferences", { token: ownerToken })).body.prefs).toEqual({});
    expect((await call("/v1/notifications/preferences", { token: maxToken })).body.prefs).toEqual({ sales: { inApp: false } });
  });
});
