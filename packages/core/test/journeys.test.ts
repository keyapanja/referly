import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { systemContext } from "../src/context";
import * as journeys from "../src/services/journeys";
import * as conversions from "../src/services/conversions";
import * as leads from "../src/services/leads";
import * as programs from "../src/services/programs";
import * as retention from "../src/services/retention";
import * as tenants from "../src/services/tenants";
import { withTenantScope } from "../src/db/rls";

/**
 * Website tracking (TRK-09): site key lifecycle and origin rules, event ingest with click
 * resolution and visitor memory, the visitor id as attribution evidence, conversions landing
 * on the journey, session listing and summaries, and retention.
 */
let db: Db;
const clock = makeClock("2026-04-01T09:00:00Z");
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock, { programOverrides: { approvalMode: "auto", holdingDays: 0, attributionWindowDays: 14 } });
});
afterAll(closeDb);

const at = (offsetMs: number) => clock.now().getTime() + offsetMs;

describe("website tracking settings", () => {
  it("is off until enabled; enabling mints a stable site key that resolves the workspace; rotation replaces it", async () => {
    const before = await journeys.getTracking(db, ws.ctx);
    expect(before).toMatchObject({ enabled: false, siteKey: null, domains: [], pixelConversions: false, lastEventAt: null, events7d: 0 });
    const key = await journeys.enableTracking(db, ws.ctx);
    expect(key).toMatch(/^site_[A-Za-z0-9]{24}$/);
    expect(await journeys.enableTracking(db, ws.ctx)).toBe(key);
    expect((await journeys.getTenantBySiteKey(db, key))?.id).toBe(ws.tenant.id);
    expect(await journeys.getTenantBySiteKey(db, "site_nope")).toBeNull();
    expect(await journeys.getTenantBySiteKey(db, "'; drop table tenants; --")).toBeNull();
    const rotated = await journeys.rotateSiteKey(db, ws.ctx);
    expect(rotated).not.toBe(key);
    expect(await journeys.getTenantBySiteKey(db, key)).toBeNull();
    expect((await journeys.getTenantBySiteKey(db, rotated))?.id).toBe(ws.tenant.id);
  });

  it("domains are normalised hostnames; snippet-reported orders need at least one domain; origins match the list and subdomains", async () => {
    await expect(journeys.updateTracking(db, ws.ctx, { pixelConversions: true })).rejects.toThrow(/domains/);
    await expect(journeys.updateTracking(db, ws.ctx, { domains: ["not a host"] })).rejects.toThrow();
    const saved = await journeys.updateTracking(db, ws.ctx, { domains: ["WWW.Shop.Example.com", "example.org"], pixelConversions: true });
    expect(saved).toEqual({ domains: ["shop.example.com", "example.org"], pixelConversions: true });
    expect(journeys.originAllowed(saved, "https://shop.example.com")).toBe(true);
    expect(journeys.originAllowed(saved, "https://www.shop.example.com")).toBe(true);
    expect(journeys.originAllowed(saved, "https://checkout.example.org")).toBe(true);
    expect(journeys.originAllowed(saved, "https://example.com")).toBe(false);
    expect(journeys.originAllowed(saved, "https://shop.example.com.evil.net")).toBe(false);
    expect(journeys.originAllowed(saved, undefined)).toBe(false);
    expect(journeys.originAllowed({}, undefined)).toBe(true);
    expect(journeys.originAllowed({ domains: [] }, "https://anything.test")).toBe(true);
    // the marketing role can read but not change tracking
    const marketing = { ...ws.ctx, actor: { type: "user" as const, id: "u", role: "marketing" as const } };
    await expect(journeys.updateTracking(db, marketing, { domains: [] })).rejects.toThrow(/integrations.manage/);
    await journeys.updateTracking(db, ws.ctx, { domains: [], pixelConversions: false });
  });
});

describe("journey ingest and attribution", () => {
  let aliceId: string;
  let clickToken: string;
  const visitor = "v_alice_visitor_01";

  it("a batch with the click token from the landing URL is tied to the affiliate and returns the program's window as the cookie ttl", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    aliceId = alice.id;
    const click = await clickFor(db, ws, alice, clock);
    clickToken = click.token;
    const result = await journeys.ingestEvents(db, systemContext(ws.tenant.id, clock.now), {
      visitorId: visitor,
      sessionId: "s_first_session_01",
      ref: clickToken,
      events: [
        { type: "page_view", url: "https://acme.example.com/coaching?ref=" + clickToken + "&utm=x", title: "Coaching", referrer: "https://blog.partner.io/post", at: at(0) },
        { type: "page_view", url: "https://acme.example.com/pricing", title: "Pricing", at: at(30_000) },
        { type: "event", name: "add_to_cart", url: "https://acme.example.com/pricing", properties: { sku: "COACH-1", value: 1000, nested: { deep: true }, long: "x".repeat(900) }, at: at(45_000) },
      ],
    });
    expect(result).toEqual({ accepted: 3, attributed: true, ref: { ttlSeconds: 14 * 86_400 } });
    const events = await journeys.sessionEvents(db, ws.ctx, visitor, "s_first_session_01");
    expect(events.map((e) => e.type)).toEqual(["page_view", "page_view", "event"]);
    expect(events[0]!).toMatchObject({ affiliateId: aliceId, programId: ws.program.id, path: "/coaching?ref=" + clickToken + "&utm=x", title: "Coaching", referrer: "https://blog.partner.io/post" });
    expect(events[0]!.clickId).toBeTruthy();
    expect(events[2]!.name).toBe("add_to_cart");
    // properties are bounded: nested values stringified, long strings cut
    expect(events[2]!.properties).toMatchObject({ sku: "COACH-1", value: 1000, nested: '{"deep":true}' });
    expect((events[2]!.properties.long as string).length).toBe(500);
    expect(events[0]!.occurredAt.getTime()).toBe(at(0));
  });

  it("a later batch without a ref (cookie gone) stays with the visitor's earlier click; an implausible client clock is replaced by the server's", async () => {
    clock.advanceDays(2);
    const result = await journeys.ingestEvents(db, systemContext(ws.tenant.id, clock.now), {
      visitorId: visitor,
      sessionId: "s_second_session_1",
      events: [{ type: "page_view", url: "https://acme.example.com/pricing", at: at(-5 * 86_400_000) }],
    });
    expect(result).toEqual({ accepted: 1, attributed: true, ref: null });
    const [ev] = await journeys.sessionEvents(db, ws.ctx, visitor, "s_second_session_1");
    expect(ev!.affiliateId).toBe(aliceId);
    expect(ev!.occurredAt.getTime()).toBe(clock.now().getTime());
    // a stranger with no ref is recorded, unattributed
    const stranger = await journeys.ingestEvents(db, systemContext(ws.tenant.id, clock.now), { visitorId: "v_stranger_000001", sessionId: "s_stranger_00001", ref: "not-a-token", events: [{ type: "page_view", url: "https://acme.example.com/" }] });
    expect(stranger).toEqual({ accepted: 1, attributed: false, ref: null });
    expect(await journeys.visitorClickTokens(db, ws.ctx, visitor)).toEqual([clickToken]);
    expect(await journeys.visitorClickTokens(db, ws.ctx, "v_stranger_000001")).toEqual([]);
  });

  it("the ingest schema refuses malformed batches", async () => {
    const ctx = systemContext(ws.tenant.id, clock.now);
    await expect(journeys.ingestEvents(db, ctx, { visitorId: "short", sessionId: "s_ok_session_0001", events: [{ type: "page_view" }] })).rejects.toThrow();
    await expect(journeys.ingestEvents(db, ctx, { visitorId: visitor, sessionId: "s_ok_session_0001", events: [] })).rejects.toThrow();
    await expect(journeys.ingestEvents(db, ctx, { visitorId: visitor, sessionId: "s_ok_session_0001", events: [{ type: "purchase" as never }] })).rejects.toThrow();
    await expect(journeys.ingestEvents(db, ctx, { visitorId: visitor, sessionId: "s_ok_session_0001", events: Array.from({ length: 51 }, () => ({ type: "page_view" as const })) })).rejects.toThrow();
  });

  it("a server-side sale that carries only the visitor id is attributed through the visitor's recorded click and lands on the journey", async () => {
    const result = await conversions.recordConversion(db, ws.ctx, { source: "api", externalOrderId: "J-100", offerId: ws.offer.id, amountMinor: 50_000, visitorId: visitor, metadata: { url: "https://acme.example.com/thanks" } });
    expect(result.conversion.affiliateId).toBe(aliceId);
    expect(result.attribution?.ruleApplied).toBe("last_click");
    expect(result.commission?.amountMinor).toBe(10_000);
    const journey = await journeys.journeyForConversion(db, ws.ctx, result.conversion.id, result.attribution?.clickId ?? null);
    expect(journey.visitorId).toBe(visitor);
    const sale = journey.events.find((e) => e.type === "conversion");
    expect(sale).toMatchObject({ conversionId: result.conversion.id, name: "J-100", affiliateId: aliceId, sessionId: "s_second_session_1", path: "/thanks", properties: { amountMinor: 50_000, currency: "USD", source: "api", attributed: true } });
    expect(journey.events.map((e) => e.type)).toEqual(["page_view", "page_view", "event", "page_view", "conversion"]);
  });

  it("a sale reported with the click token but no visitor id still lands on the journey through the click", async () => {
    const result = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "J-101", offerId: ws.offer.id, amountMinor: 10_000, clickToken });
    expect(result.conversion.affiliateId).toBe(aliceId);
    const journey = await journeys.journeyForConversion(db, ws.ctx, result.conversion.id, result.attribution?.clickId ?? null);
    expect(journey.visitorId).toBe(visitor);
    expect(journey.events.filter((e) => e.type === "conversion").map((e) => e.name)).toEqual(["J-100", "J-101"]);
    // a sale with no evidence at all has no journey
    const orphan = await conversions.recordConversion(db, ws.ctx, { source: "api", externalOrderId: "J-102", offerId: ws.offer.id, amountMinor: 1_000 });
    expect(await journeys.journeyForConversion(db, ws.ctx, orphan.conversion.id, null)).toEqual({ visitorId: null, events: [] });
  });

  it("a lead captured with the visitor id is attributed the same way and shows as a lead on the journey", async () => {
    await programs.updateProgram(db, ws.ctx, ws.program.id, { leadsEnabled: true, leadCommissionMinor: 500, leadApproval: "manual", leadDedupeDays: 30 });
    const lead = await leads.recordLead(db, ws.ctx, { source: "form", email: "buyer@example.com", visitorId: visitor, programId: ws.program.id });
    expect(lead.lead.affiliateId).toBe(aliceId);
    const journey = await journeys.journeyForConversion(db, ws.ctx, lead.lead.conversionId, null);
    expect(journey.events.at(-1)).toMatchObject({ type: "lead", conversionId: lead.lead.conversionId, affiliateId: aliceId });
  });

  it("sessions are listed per visit with landing page, counts, outcome and affiliate name; summaries count visits", async () => {
    const sessions = await journeys.listSessions(db, ws.ctx, { days: 30 });
    expect(sessions.map((s) => s.sessionId)).toEqual(["s_second_session_1", "s_first_session_01"]);
    expect(sessions[1]!).toMatchObject({ visitorId: visitor, affiliateId: aliceId, affiliateName: "Alice", pages: 2, events: 1, conversions: 0, leads: 0, landingPath: "/coaching?ref=" + clickToken + "&utm=x", referrer: "https://blog.partner.io/post", outcome: "engaged" });
    expect(sessions[0]!).toMatchObject({ sessionId: "s_second_session_1", pages: 1, conversions: 2, leads: 1, outcome: "converted" });
    expect(sessions[0]!.startedAt).toBeInstanceOf(Date);
    // filters
    expect((await journeys.listSessions(db, ws.ctx, { converted: true })).map((s) => s.sessionId)).toEqual(["s_second_session_1"]);
    expect((await journeys.listSessions(db, ws.ctx, { affiliateId: "aff_nobody" })).length).toBe(0);
    const all = await journeys.listSessions(db, ws.ctx, { attributed: false });
    expect(all.some((s) => s.visitorId === "v_stranger_000001" && s.affiliateId === null && s.outcome === "browsing")).toBe(true);
    expect(await journeys.journeySummary(db, ws.ctx, 30)).toEqual({ sessions: 3, attributedSessions: 2, convertedSessions: 1, pageViews: 4 });
    const tracking = await journeys.getTracking(db, ws.ctx);
    expect(tracking.lastEventHost).toBe("acme.example.com");
    expect(tracking.visitors7d).toBe(2);
    // a shorter window: only the visits of the last day (Alice's second visit and the stranger)
    expect(await journeys.journeySummary(db, ws.ctx, 1)).toEqual({ sessions: 2, attributedSessions: 1, convertedSessions: 1, pageViews: 2 });
  });

  it("another workspace sees nothing of these journeys, under RLS and through the service", async () => {
    const other = await createWorkspace(db, clock);
    expect(await journeys.listSessions(db, other.ctx, { attributed: false })).toEqual([]);
    expect(await journeys.sessionEvents(db, other.ctx, visitor, "s_first_session_01")).toEqual([]);
    const scoped = await withTenantScope(db, other.tenant.id, (tx) => journeys.visitorEvents(tx, other.ctx, visitor));
    expect(scoped).toEqual([]);
  });

  it("retention prunes journey rows older than journeyDays and the click they pointed at can go too", async () => {
    const policy = { ...retention.RETENTION_DEFAULTS, journeyDays: 7, clicksDays: 30 };
    clock.advanceDays(10);
    const ctx = { ...ws.ctx, now: clock.now };
    const preview = await retention.previewPrune(db, ctx, policy);
    expect(preview.journeyDays).toBeGreaterThan(0);
    const counts = await retention.pruneTenant(db, ctx, policy);
    expect(counts.journeyDays).toBe(preview.journeyDays);
    expect(await journeys.visitorEvents(db, ws.ctx, visitor)).toEqual([]);
    expect(retention.RETENTION_BOUNDS.journeyDays).toEqual([7, 400]);
    await expect(retention.updateRetention(db, ws.ctx, { journeyDays: 3 })).rejects.toThrow();
    await retention.updateRetention(db, ws.ctx, { journeyDays: 14 });
    expect((await tenants.getTenant(db, ws.ctx)).retention?.journeyDays).toBe(14);
  });
});

describe("consent mode", () => {
  it("is a workspace setting carried on the install snippet; with it on, batches without consent are dropped and consented events are marked", async () => {
    const ws2 = await createWorkspace(db, clock);
    await journeys.enableTracking(db, ws2.ctx);
    expect((await journeys.getTracking(db, ws2.ctx)).consentMode).toBe("off");
    expect((await journeys.updateTracking(db, ws2.ctx, { consentMode: "wait" })).consentMode).toBe("wait");
    await expect(journeys.updateTracking(db, ws2.ctx, { consentMode: "maybe" as never })).rejects.toThrow();
    const ctx = systemContext(ws2.tenant.id, clock.now);
    const batch = { visitorId: "v_eu_visitor_00001", sessionId: "s_eu_session_00001", events: [{ type: "page_view" as const, url: "https://acme.example.com/" }] };
    expect(await journeys.ingestEvents(db, ctx, batch, { consentRequired: true })).toEqual({ accepted: 0, attributed: false, ref: null, dropped: "consent_required" });
    expect(await journeys.ingestEvents(db, ctx, { ...batch, consent: "not_required" }, { consentRequired: true })).toMatchObject({ accepted: 0, dropped: "consent_required" });
    expect(await journeys.visitorEvents(db, ws2.ctx, batch.visitorId)).toEqual([]);
    expect(await journeys.ingestEvents(db, ctx, { ...batch, consent: "granted" }, { consentRequired: true })).toEqual({ accepted: 1, attributed: false, ref: null });
    const [ev] = await journeys.visitorEvents(db, ws2.ctx, batch.visitorId);
    expect(ev!.consentState).toBe("granted");
    // without consent mode the flag is simply recorded as not required
    expect(await journeys.ingestEvents(db, ctx, batch)).toMatchObject({ accepted: 1 });
    const rows = await journeys.visitorEvents(db, ws2.ctx, batch.visitorId);
    expect(rows.map((r) => r.consentState)).toEqual(["granted", "not_required"]);
    // a sale linked to this visitor inherits the latest consent state
    const sale = await conversions.recordConversion(db, ws2.ctx, { source: "api", externalOrderId: "EU-1", offerId: ws2.offer.id, amountMinor: 1_000, visitorId: batch.visitorId });
    const journey = await journeys.journeyForConversion(db, ws2.ctx, sale.conversion.id, null);
    expect(journey.events.at(-1)).toMatchObject({ type: "conversion", consentState: "not_required" });
  });
});
