import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { createTestDb, journeys, messaging, type DbHandle } from "@referly/core";
import { createApp, type App } from "../src/app";
import { resetRateLimits } from "../src/lib/ratelimit";
import { LocalStorage } from "../src/storage";
import { createLogger } from "../src/lib/log";
import { connectionKey, parseConnectionKey } from "../src/wordpress";

/**
 * The WordPress plugin: the installable zip the API serves, the one-paste connection key, the
 * narrow /v1/connection endpoint the plugin reads its settings from, what the plugin's key may
 * and may not do, and the exact requests the plugin makes to report an order and a refund.
 */
let handle: DbHandle;
let app: App;
let clock = new Date("2026-09-11T10:00:00Z");
const now = () => new Date(clock);
const email = new messaging.MemoryEmailProvider();
const quiet = createLogger({ level: "error", write: () => {} });
const BASE = "http://api.test";
const source = (file: string) => readFileSync(new URL(`../src/wordpress/${file}`, import.meta.url));

beforeAll(async () => {
  handle = await createTestDb();
  const storage = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-wordpress-")), BASE);
  app = createApp({ db: handle.db, email, storage, log: quiet, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
  resetRateLimits();
});
afterAll(() => handle.close());

async function call<T = any>(p: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<{ status: number; body: T }> {
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
  return { status: res.status, body };
}

/** Read a zip the way an unzip tool does: end record, central directory, then each local header. */
function readZip(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: { name: string; method: number; crc: number; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    entries.push({ name, method, crc, data: buf.subarray(dataStart, dataStart + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe("WordPress plugin", () => {
  let ownerToken: string;
  let marketingToken: string;
  let pluginKey: string;
  let siteKey: string;

  it("serves an installable zip whose files are the plugin source, byte for byte", async () => {
    const res = await app.request(`${BASE}/wordpress/referly.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="referly.zip"');
    const buf = Buffer.from(await res.arrayBuffer());
    const entries = readZip(buf);
    expect(entries.map((e) => e.name)).toEqual(["referly/", "referly/referly.php", "referly/readme.txt"]);
    for (const e of entries.slice(1)) {
      expect(e.method, e.name).toBe(0);
      expect(e.crc, e.name).toBe(crc32(e.data));
      expect(Buffer.compare(e.data, source(e.name.slice("referly/".length))), e.name).toBe(0);
    }
    const php = entries[1]!.data.toString("utf8");
    expect(php.startsWith("<?php")).toBe(true);
    expect(php).toMatch(/Plugin Name:\s+Referly/);
    expect(res.headers.get("x-plugin-version")).toBe(/Version:\s*([0-9.]+)/.exec(php)![1]);
    // the same bytes every time, so browsers and proxies can cache it
    expect(Buffer.compare(Buffer.from(await (await app.request(`${BASE}/wordpress/referly.zip`)).arrayBuffer()), buf)).toBe(0);
  });

  it("the plugin's PHP talks to the endpoints, and with the fields, this API accepts", () => {
    const php = source("referly.php").toString("utf8");
    expect(php).toContain("'/v1/connection'");
    expect(php).toContain("'/v1/conversions'");
    expect(php).toContain("'/refund'");
    expect(php).toMatch(/'source'\s*=>\s*'woocommerce'/);
    // the cookies the snippet writes, validated with the same patterns the API uses
    expect(php).toContain(`'referly_vid' => '/${journeys.VISITOR_ID.source}/'`);
    expect(php).toContain("'referly_ref' =>");
    expect(php).toContain("rfly1_");
    // orders without an affiliate click or coupon never leave the store, and a skipped answer is understood
    expect(php).toContain("! $order->get_coupon_codes()");
    expect(php).toContain("'recorded'");
    // the connection key format the PHP parses is the one the API mints
    expect(parseConnectionKey(connectionKey("https://api.example.com/", "rk_live_abc123"))).toEqual({ api: "https://api.example.com", key: "rk_live_abc123" });
    expect(parseConnectionKey("rfly1_not-json")).toBeNull();
    expect(parseConnectionKey("something else")).toBeNull();
  });

  it("an owner creates a connection key: it switches tracking on and carries the API address and a new key", async () => {
    const signup = await call("/v1/auth/signup", { method: "POST", json: { name: "WP Shop", slug: "wp-shop", currency: "USD", owner: { name: "Wes", email: "wes@wp.test", password: "supersecret1" } } });
    ownerToken = signup.body.token;
    await call("/v1/tenant/team", { method: "POST", token: ownerToken, json: { name: "Mo", email: "mo@wp.test", password: "supersecret1", role: "marketing" } });
    marketingToken = (await call("/v1/auth/login", { method: "POST", json: { email: "mo@wp.test", password: "supersecret1" } })).body.token;

    expect((await call("/v1/tenant/tracking/wordpress", { method: "POST", token: marketingToken })).status).toBe(403);
    const res = await call("/v1/tenant/tracking/wordpress", { method: "POST", token: ownerToken });
    expect(res.status).toBe(201);
    expect(res.body.connectionKey).toMatch(/^rfly1_[A-Za-z0-9_-]+$/);
    expect(res.body.apiKey).toMatchObject({ name: "WordPress plugin" });
    const parsed = parseConnectionKey(res.body.connectionKey)!;
    expect(parsed.api).toBe(BASE);
    expect(parsed.key).toMatch(/^rk_live_[A-Za-z0-9]+$/);
    pluginKey = parsed.key;

    const tracking = await call("/v1/tenant/tracking", { token: ownerToken });
    expect(tracking.body.enabled).toBe(true);
    siteKey = tracking.body.siteKey;
    const wordpress = tracking.body.platforms.find((p: any) => p.id === "wordpress");
    expect(wordpress.plugin.downloadUrl).toBe(`${BASE}/wordpress/referly.zip`);
    expect(wordpress.order).toBeUndefined();
  });

  it("the plugin reads its settings from /v1/connection, and its key can do nothing beyond reporting", async () => {
    const conn = await call("/v1/connection", { token: pluginKey });
    expect(conn.status).toBe(200);
    expect(conn.body).toEqual({
      workspace: { id: expect.stringMatching(/^ten_/), name: "WP Shop", currency: "USD" },
      tracking: { enabled: true, siteKey, scriptUrl: `${BASE}/referly.js`, apiUrl: BASE, consentMode: "off" },
    });
    await call("/v1/tenant/tracking", { method: "PATCH", token: ownerToken, json: { consentMode: "wait" } });
    expect((await call("/v1/connection", { token: pluginKey })).body.tracking.consentMode).toBe("wait");
    await call("/v1/tenant/tracking", { method: "PATCH", token: ownerToken, json: { consentMode: "off" } });

    expect((await call("/v1/connection")).status).toBe(401);
    expect((await call("/v1/connection", { token: "rk_live_notakey" })).status).toBe(401);
    const readOnly = (await call("/v1/tenant/api-keys", { method: "POST", token: ownerToken, json: { name: "reports", scopes: ["read"] } })).body.secret;
    expect((await call("/v1/connection", { token: readOnly })).status).toBe(403);

    expect((await call("/v1/affiliates", { token: pluginKey })).status).toBe(403);
    expect((await call("/v1/tenant/tracking", { token: pluginKey })).status).toBe(403);
    expect((await call("/v1/tenant/tracking/wordpress", { method: "POST", token: pluginKey })).status).toBe(403);
  });

  it("reports an order exactly as the plugin does: attributed through the checkout cookies, idempotent, and refundable", async () => {
    const offer = await call("/v1/offers", { method: "POST", token: ownerToken, json: { name: "Course", priceMinor: 11_800, salesUrl: "https://shop.wp.test/course" } });
    const offerId = offer.body.offer.id;
    await call(`/v1/offers/${offerId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const program = await call("/v1/programs", { method: "POST", token: ownerToken, json: { name: "Partners", commissionModel: "percentage", commissionPercent: 10, holdingDays: 0, attributionWindowDays: 30, refundPolicy: "full", offerIds: [offerId], approvalMode: "auto", termsText: "Be nice." } });
    const programId = program.body.program.id;
    await call(`/v1/programs/${programId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const invite = await call("/v1/affiliates/invites", { method: "POST", token: ownerToken, json: { programId, email: "pat@partner.test", name: "Pat" } });
    const accept = await call(`/invite/${invite.body.invite.token}/accept`, { method: "POST", json: { name: "Pat Partner", password: "partnerpass1", acceptTerms: true } });
    const affiliateId = accept.body.affiliate.id;
    const link = await call("/portal/links", { method: "POST", token: accept.body.token, json: { programId, offerId } });
    const redirect = await app.request(`${BASE}/r/${link.body.link.token}`, { redirect: "manual" });
    const clickToken = new URL(redirect.headers.get("location")!).searchParams.get("ref")!;
    expect((await call("/v1/connection", { token: accept.body.token })).status).toBe(403);

    // the customer pays five minutes later; the plugin posts what WooCommerce and the cookies hold
    clock = new Date(clock.getTime() + 5 * 60_000);
    const order = { source: "woocommerce", externalOrderId: "1042", amountMinor: 11_800, netAmountMinor: 10_000, currency: "USD", customerEmail: "buyer@example.com", clickToken, visitorId: "vWooVisitor000000001", occurredAt: "2026-09-11T10:03:00+00:00" };
    const first = await call("/v1/conversions", { method: "POST", token: pluginKey, json: order });
    expect(first.status).toBe(201);
    expect(first.body.recorded).toBe(true);
    expect(first.body.conversion).toMatchObject({ source: "woocommerce", externalOrderId: "1042", affiliateId, amountMinor: 11_800, netAmountMinor: 10_000, currency: "USD" });
    expect(first.body.commission.amountMinor).toBeGreaterThan(0);

    const again = await call("/v1/conversions", { method: "POST", token: pluginKey, json: order });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.conversion.id).toBe(first.body.conversion.id);

    const refund = await call(`/v1/conversions/${first.body.conversion.id}/refund`, { method: "POST", token: pluginKey, json: { amountMinor: 11_800, reason: "Refunded in WooCommerce" } });
    expect(refund.status).toBe(200);
    expect(refund.body.conversion.refundedAmountMinor).toBe(11_800);

    // an order no affiliate can claim is acknowledged, not stored, and never reaches the affiliate
    const stray = await call("/v1/conversions", { method: "POST", token: pluginKey, json: { source: "woocommerce", externalOrderId: "1043", amountMinor: 5_000, currency: "USD" } });
    expect(stray.status).toBe(200);
    expect(stray.body).toMatchObject({ recorded: false, reason: "no_affiliate", conversion: null });
    const list = await call("/v1/conversions?limit=50", { token: ownerToken });
    expect(list.body.conversions.some((c: any) => c.externalOrderId === "1043")).toBe(false);
  });
});
