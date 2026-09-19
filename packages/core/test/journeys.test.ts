import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { systemContext } from "../src/context";
import { clicks, journeyStats } from "../src/db/schema";
import * as journeys from "../src/services/journeys";
import * as conversions from "../src/services/conversions";
import * as leads from "../src/services/leads";
import * as retention from "../src/services/retention";
import * as tenants from "../src/services/tenants";
import * as tracking from "../src/services/tracking";
import { withTenantScope } from "../src/db/rls";

/**
 * Website tracking (TRK-09) as totals: site key lifecycle and origin rules, hits from the
 * snippet becoming daily counters per affiliate and page with nothing kept per visitor, page
 * normalisation and the caps that bound the table, the funnel report with purchases counted from
 * the sales themselves, the visitor id as attribution evidence through the click row, and
 * retention.
 */
let db: Db;
const clock = makeClock("2026-04-01T09:00:00Z");
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock, { programOverrides: { approvalMode: "auto", holdingDays: 0, attributionWindowDays: 14 } });
});
afterAll(closeDb);

const SHOP = "https://shop.example.com";
/** What the snippet sends for a stage: both flags set means "first time today, on the site and on this page". */
const hit = (s: "visit" | "half" | "bottom" | "checkout", path: string, flags: { site?: boolean; page?: boolean } = { site: true, page: true }) => ({ s, url: `${SHOP}${path}`, ...flags });

describe("website tracking settings", () => {
  it("is off until enabled; enabling mints a stable site key that resolves the workspace; rotation replaces it", async () => {
    const before = await journeys.getTracking(db, ws.ctx);
    expect(before).toMatchObject({ enabled: false, siteKey: null, domains: [], pixelConversions: false, checkoutPaths: [], lastEventAt: null, lastEventHost: null, visitors7d: 0, checkouts7d: 0 });
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

  it("checkout addresses are kept as path fragments, whatever was pasted", async () => {
    const saved = await journeys.updateTracking(db, ws.ctx, { checkoutPaths: ["buy", "/Enroll/", "https://shop.example.com/pay-now?step=2", "/buy"] });
    expect(saved.checkoutPaths).toEqual(["/buy", "/enroll/", "/pay-now"]);
    expect((await journeys.getTracking(db, ws.ctx)).checkoutPaths).toEqual(["/buy", "/enroll/", "/pay-now"]);
    await expect(journeys.updateTracking(db, ws.ctx, { checkoutPaths: ['/x" onload="alert(1)'] })).rejects.toThrow();
    await expect(journeys.updateTracking(db, ws.ctx, { checkoutPaths: ["/"] })).rejects.toThrow();
    await journeys.updateTracking(db, ws.ctx, { checkoutPaths: [] });
  });
});

describe("pages", () => {
  it("are host and path only: no query string, no www, no trailing slash, and ids folded so one order is not one page", () => {
    expect(journeys.normalizePage("https://WWW.Shop.Example.com/Pricing/?ref=abc123&email=a@b.co#plans")).toBe("shop.example.com/pricing");
    expect(journeys.normalizePage("https://shop.example.com/")).toBe("shop.example.com");
    expect(journeys.normalizePage("https://shop.example.com/checkout/order-received/10452/?key=wc_order_Ab12Cd34")).toBe("shop.example.com/checkout/order-received/:id");
    expect(journeys.normalizePage("https://shop.example.com/orders/3f2504e0-4f89-41d3-9a0c-0305e82c3301/status")).toBe("shop.example.com/orders/:id/status");
    expect(journeys.normalizePage("https://acme.myshopify.com/checkouts/cn/Z2NwLXVzLWNlbnRyYWwxOjAxSjk4/information")).toBe("acme.myshopify.com/checkouts/cn/:id/information");
    // an ordinary long slug is a page, not an id
    expect(journeys.normalizePage("https://shop.example.com/blog/how-to-choose-a-standing-desk")).toBe("shop.example.com/blog/how-to-choose-a-standing-desk");
    expect(journeys.normalizePage(`https://shop.example.com/${"z".repeat(400)}`)!.length).toBe(160);
    expect(journeys.normalizePage("javascript:alert(1)")).toBeNull();
    expect(journeys.normalizePage("not a url")).toBeNull();
    expect(journeys.normalizePage(undefined)).toBeNull();
  });
});

describe("hits become daily counters", () => {
  let aliceId: string;
  let bobId: string;
  let aliceClick: { id: string; token: string };
  let bobToken: string;
  const ctx = () => systemContext(ws.tenant.id, clock.now);

  it("a visitor's first batch counts them on the site, on the page and as landing there, and returns the program's window as the cookie ttl", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    aliceId = alice.id;
    const click = await clickFor(db, ws, alice, clock);
    aliceClick = { id: click.click.id, token: click.token };
    const res = await journeys.ingestHits(db, ctx(), { visitorId: "v_alice_visitor_01", ref: click.token, hits: [hit("visit", "/course?ref=" + click.token), hit("half", "/course")] });
    expect(res).toEqual({ accepted: 2, attributed: true, ref: { ttlSeconds: 14 * 86_400 } });

    const rows = await db.select().from(journeyStats).where(eq(journeyStats.tenantId, ws.tenant.id));
    expect(rows.map((r) => [r.day, r.affiliateId, r.page, r.stage, r.count]).sort()).toEqual(
      [
        ["2026-04-01", aliceId, "", "half", 1],
        ["2026-04-01", aliceId, "", "visit", 1],
        ["2026-04-01", aliceId, "shop.example.com/course", "half", 1],
        ["2026-04-01", aliceId, "shop.example.com/course", "land", 1],
        ["2026-04-01", aliceId, "shop.example.com/course", "visit", 1],
      ].sort(),
    );
    // nothing about the visitor is in the counters; only the click remembers who landed with it
    expect(JSON.stringify(rows)).not.toContain("v_alice_visitor_01");
    expect((await db.query.clicks.findFirst({ where: eq(clicks.id, aliceClick.id) }))!.visitorId).toBe("v_alice_visitor_01");
  });

  it("later pages the same day add to the page, not to the site; a second visitor adds to both; another affiliate has rows of their own", async () => {
    // Alice's visitor moves on: already counted on the site today, new on these pages
    await journeys.ingestHits(db, ctx(), { visitorId: "v_alice_visitor_01", ref: aliceClick.token, hits: [hit("visit", "/pricing", { page: true }), hit("bottom", "/pricing"), hit("visit", "/checkout", { page: true }), hit("checkout", "/checkout")] });
    // a hit the browser says it has already reported adds nothing
    expect((await journeys.ingestHits(db, ctx(), { ref: aliceClick.token, hits: [hit("visit", "/pricing", {})] })).accepted).toBe(0);
    // a second person through the same affiliate's link
    const alice2 = await clickFor(db, ws, { id: aliceId } as never, clock);
    await journeys.ingestHits(db, ctx(), { visitorId: "v_alice_visitor_02", ref: alice2.token, hits: [hit("visit", "/course")] });
    // and one through Bob's
    const bob = await createActiveAffiliate(db, ws, "Bob");
    bobId = bob.id;
    bobToken = (await clickFor(db, ws, bob, clock)).token;
    await journeys.ingestHits(db, ctx(), { visitorId: "v_bob_visitor_0001", ref: bobToken, hits: [hit("visit", "/course"), hit("half", "/course"), hit("bottom", "/course")] });

    const all = await journeys.journeyReport(db, ws.ctx, { days: 30 });
    expect(all.funnel).toMatchObject({ visitors: 3, half: 2, bottom: 2, checkout: 1, purchases: 0, leads: 0 });
    expect(all.pages).toEqual([
      { page: "shop.example.com/course", landed: 3, visitors: 3, half: 2, bottom: 1, checkout: 0 },
      { page: "shop.example.com/checkout", landed: 0, visitors: 1, half: 0, bottom: 0, checkout: 1 },
      { page: "shop.example.com/pricing", landed: 0, visitors: 1, half: 0, bottom: 1, checkout: 0 },
    ]);
    const bobs = await journeys.journeyReport(db, ws.ctx, { days: 30, affiliateId: bobId });
    expect(bobs.funnel).toMatchObject({ visitors: 1, half: 1, bottom: 1, checkout: 0 });
    expect(bobs.pages).toEqual([{ page: "shop.example.com/course", landed: 1, visitors: 1, half: 1, bottom: 1, checkout: 0 }]);
    // the row count is bounded by days, affiliates, pages and stages, not by visitors
    const before = (await db.select().from(journeyStats).where(eq(journeyStats.tenantId, ws.tenant.id))).length;
    for (let i = 0; i < 25; i++) await journeys.ingestHits(db, ctx(), { visitorId: `v_crowd_visitor_${String(i).padStart(3, "0")}`, ref: bobToken, hits: [hit("visit", "/course"), hit("half", "/course"), hit("bottom", "/course")] });
    expect((await db.select().from(journeyStats).where(eq(journeyStats.tenantId, ws.tenant.id))).length).toBe(before);
    expect((await journeys.journeyReport(db, ws.ctx, { affiliateId: bobId })).funnel.visitors).toBe(26);
  });

  it("the site's own events are counted by name, once per visitor per day, and the tracking page shows the last hit and the week's totals", async () => {
    await journeys.ingestHits(db, ctx(), { ref: aliceClick.token, hits: [{ s: "event", n: "add_to_cart", url: `${SHOP}/course`, site: true }, { s: "event", n: "add_to_cart", url: `${SHOP}/course` }, { s: "event", n: "<script>", site: true }, { s: "event", site: true }] });
    await journeys.ingestHits(db, ctx(), { ref: bobToken, hits: [{ s: "event", n: "add_to_cart", site: true }, { s: "event", n: "watched video", site: true }] });
    const report = await journeys.journeyReport(db, ws.ctx);
    expect(report.events).toEqual([
      { name: "add_to_cart", visitors: 2 },
      { name: "watched video", visitors: 1 },
    ]);
    const view = await journeys.getTracking(db, ws.ctx);
    expect(view).toMatchObject({ lastEventHost: "shop.example.com", visitors7d: 28, checkouts7d: 1 });
    expect(view.lastEventAt?.getTime()).toBe(clock.now().getTime());
  });

  it("refuses what no affiliate sent, malformed batches, and acknowledges an older snippet's batch without counting it", async () => {
    expect(await journeys.ingestHits(db, ctx(), { visitorId: "v_nobody_visitor_1", hits: [hit("visit", "/course")] })).toEqual({ accepted: 0, attributed: false, ref: null, dropped: "no_affiliate" });
    expect(await journeys.ingestHits(db, ctx(), { ref: "not-a-real-token", hits: [hit("visit", "/course")] })).toMatchObject({ accepted: 0, dropped: "no_affiliate" });
    await expect(journeys.ingestHits(db, ctx(), { ref: aliceClick.token, hits: [] })).rejects.toThrow();
    await expect(journeys.ingestHits(db, ctx(), { ref: aliceClick.token, hits: [{ s: "teleported", url: SHOP }] })).rejects.toThrow();
    await expect(journeys.ingestHits(db, ctx(), { ref: aliceClick.token, visitorId: "x", hits: [hit("visit", "/")] })).rejects.toThrow();
    await expect(journeys.ingestHits(db, ctx(), { ref: aliceClick.token, hits: Array.from({ length: 51 }, () => hit("visit", "/")) })).rejects.toThrow();
    const before = await journeys.journeyReport(db, ws.ctx);
    const legacy = { visitorId: "v_alice_visitor_01", sessionId: "s_old_snippet_0001", ref: aliceClick.token, events: [{ type: "page_view", url: `${SHOP}/course` }] };
    expect(await journeys.ingestHits(db, ctx(), legacy)).toEqual({ accepted: 0, attributed: true, ref: { ttlSeconds: 14 * 86_400 }, dropped: "legacy" });
    expect((await journeys.journeyReport(db, ws.ctx)).funnel).toEqual(before.funnel);
  });

  it("purchases in the funnel come from the sales a link earned; coupon-only sales are counted beside it, hand-entered ones not at all", async () => {
    const alice = { id: aliceId };
    const sale = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "J-1", offerId: ws.offer.id, amountMinor: 99_900, clickToken: aliceClick.token });
    expect(sale.conversion.attributionSource).toBe("link");
    await tracking.createCouponCode(db, ws.ctx, { affiliateId: alice.id, programId: ws.program.id, code: "ALICEJ" });
    await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "J-2", offerId: ws.offer.id, amountMinor: 50_000, couponCode: "ALICEJ" });
    await conversions.recordConversion(db, ws.ctx, { source: "manual", externalOrderId: "J-3", offerId: ws.offer.id, amountMinor: 10_000, affiliateId: alice.id, programId: ws.program.id, reason: "phone order" });
    const cancelled = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "J-4", offerId: ws.offer.id, amountMinor: 20_000, clickToken: bobToken });
    await conversions.cancelConversion(db, ws.ctx, cancelled.conversion.id, "test order");

    const report = await journeys.journeyReport(db, ws.ctx);
    expect(report.funnel).toMatchObject({ purchases: 1, revenue: [{ currency: "USD", minor: 99_900 }] });
    expect(report.couponOnlySales).toBe(1);
    expect((await journeys.journeyReport(db, ws.ctx, { affiliateId: bobId })).funnel.purchases).toBe(0);
  });

  it("a sale or a lead that carries only the visitor id finds the click that visitor landed with", async () => {
    expect(await journeys.visitorClickTokens(db, ws.ctx, "v_alice_visitor_01")).toEqual([aliceClick.token]);
    expect(await journeys.visitorClickTokens(db, ws.ctx, "v_never_seen_00001")).toEqual([]);
    const sale = await conversions.recordConversion(db, ws.ctx, { source: "woocommerce", externalOrderId: "J-5", offerId: ws.offer.id, amountMinor: 30_000, visitorId: "v_alice_visitor_01" });
    expect(sale.conversion).toMatchObject({ affiliateId: aliceId, attributionSource: "link" });
    expect(sale.attribution!.clickId).toBe(aliceClick.id);
    // a second click by the same person is remembered too, and the most recent one wins last-touch
    clock.advanceDays(1);
    const again = await clickFor(db, ws, { id: bobId } as never, clock);
    await journeys.ingestHits(db, ctx(), { visitorId: "v_alice_visitor_01", ref: again.token, hits: [hit("visit", "/course")] });
    expect(await journeys.visitorClickTokens(db, ws.ctx, "v_alice_visitor_01")).toEqual([aliceClick.token, again.token]);
    // a click keeps the first visitor who landed with it
    await journeys.ingestHits(db, ctx(), { visitorId: "v_someone_else_001", ref: again.token, hits: [hit("visit", "/pricing", { page: true })] });
    expect((await db.query.clicks.findFirst({ where: eq(clicks.id, again.click.id) }))!.visitorId).toBe("v_alice_visitor_01");

    const programWithLeads = await createWorkspace(db, clock, { programOverrides: { leadsEnabled: true, leadCommissionMinor: 500, approvalMode: "auto" } });
    const cara = await createActiveAffiliate(db, programWithLeads, "Cara");
    const caraClick = await clickFor(db, programWithLeads, cara, clock);
    await journeys.ingestHits(db, systemContext(programWithLeads.tenant.id, clock.now), { visitorId: "v_cara_visitor_001", ref: caraClick.token, hits: [hit("visit", "/demo")] });
    const lead = await leads.recordLead(db, programWithLeads.ctx, { source: "form", programId: programWithLeads.program.id, email: "lead@example.com", visitorId: "v_cara_visitor_001" });
    expect(lead.lead.affiliateId).toBe(cara.id);
    expect((await journeys.journeyReport(db, programWithLeads.ctx)).funnel).toMatchObject({ visitors: 1, leads: 1, purchases: 0 });
  });

  it("the table stays bounded: past the day's page limit new pages fold into (other), and event names past theirs are dropped", async () => {
    const big = await createWorkspace(db, clock);
    const dee = await createActiveAffiliate(db, big, "Dee");
    const { token } = await clickFor(db, big, dee, clock);
    const bigCtx = systemContext(big.tenant.id, clock.now);
    for (let batch = 0; batch < 7; batch++)
      await journeys.ingestHits(db, bigCtx, { ref: token, hits: Array.from({ length: 50 }, (_, i) => hit("visit", `/p/page-${batch}-${i}`, { page: true })) });
    const pages = new Set((await db.select({ page: journeyStats.page }).from(journeyStats).where(eq(journeyStats.tenantId, big.tenant.id))).map((r) => r.page));
    expect(pages.size).toBe(301); // 300 pages and "(other)"
    expect(pages.has(journeys.OTHER_PAGE)).toBe(true);
    const [other] = await db.select().from(journeyStats).where(and(eq(journeyStats.tenantId, big.tenant.id), eq(journeyStats.page, journeys.OTHER_PAGE)));
    expect(other!.count).toBe(50);
    // a page already known today keeps counting under its own name
    await journeys.ingestHits(db, bigCtx, { ref: token, hits: [hit("visit", "/p/page-0-0", { page: true })] });
    expect((await journeys.journeyReport(db, big.ctx, { pageLimit: 300 })).pages.find((p) => p.page === "shop.example.com/p/page-0-0")!.visitors).toBe(2);

    await journeys.ingestHits(db, bigCtx, { ref: token, hits: Array.from({ length: 40 }, (_, i) => ({ s: "event" as const, n: `event_${i}`, site: true })) });
    expect((await journeys.journeyReport(db, big.ctx)).events).toHaveLength(30);
  });

  it("another workspace sees nothing of these counters, under RLS and through the service", async () => {
    const other = await createWorkspace(db, clock);
    const report = await journeys.journeyReport(db, other.ctx);
    expect(report.funnel).toMatchObject({ visitors: 0, half: 0, bottom: 0, checkout: 0, purchases: 0 });
    expect(report.pages).toEqual([]);
    const scoped = await withTenantScope(db, other.tenant.id, (tx) => tx.select().from(journeyStats));
    expect(scoped).toEqual([]);
    // and a click token from one workspace counts nothing in another
    expect(await journeys.ingestHits(db, systemContext(other.tenant.id, clock.now), { ref: aliceClick.token, hits: [hit("visit", "/course")] })).toMatchObject({ accepted: 0, dropped: "no_affiliate" });
  });

  it("retention prunes the daily totals older than journeyDays", async () => {
    const policy = { ...retention.RETENTION_DEFAULTS, journeyDays: 7, clicksDays: 30 };
    clock.advanceDays(10);
    const ctxNow = { ...ws.ctx, now: clock.now };
    const preview = await retention.previewPrune(db, ctxNow, policy);
    expect(preview.journeyDays).toBeGreaterThan(0);
    const counts = await retention.pruneTenant(db, ctxNow, policy);
    expect(counts.journeyDays).toBe(preview.journeyDays);
    expect(await db.select().from(journeyStats).where(eq(journeyStats.tenantId, ws.tenant.id))).toEqual([]);
    expect(retention.RETENTION_BOUNDS.journeyDays).toEqual([7, 400]);
    await expect(retention.updateRetention(db, ws.ctx, { journeyDays: 3 })).rejects.toThrow();
    await retention.updateRetention(db, ws.ctx, { journeyDays: 14 });
    expect((await tenants.getTenant(db, ws.ctx)).retention?.journeyDays).toBe(14);
  });
});

describe("consent mode", () => {
  it("is a workspace setting; with it on, batches without consent are dropped and consented ones counted", async () => {
    const ws2 = await createWorkspace(db, clock);
    await journeys.enableTracking(db, ws2.ctx);
    expect((await journeys.getTracking(db, ws2.ctx)).consentMode).toBe("off");
    expect((await journeys.updateTracking(db, ws2.ctx, { consentMode: "wait" })).consentMode).toBe("wait");
    await expect(journeys.updateTracking(db, ws2.ctx, { consentMode: "maybe" as never })).rejects.toThrow();
    const ctx = systemContext(ws2.tenant.id, clock.now);
    const bea = await createActiveAffiliate(db, ws2, "Bea");
    const { token, click } = await clickFor(db, ws2, bea, clock);
    const batch = { visitorId: "v_eu_visitor_00001", ref: token, hits: [hit("visit", "/")] };
    expect(await journeys.ingestHits(db, ctx, batch, { consentRequired: true })).toEqual({ accepted: 0, attributed: false, ref: null, dropped: "consent_required" });
    expect(await journeys.ingestHits(db, ctx, { ...batch, consent: "not_required" }, { consentRequired: true })).toMatchObject({ accepted: 0, dropped: "consent_required" });
    // nothing was counted and the click did not learn the visitor
    expect((await journeys.journeyReport(db, ws2.ctx)).funnel.visitors).toBe(0);
    expect((await db.query.clicks.findFirst({ where: eq(clicks.id, click.id) }))!.visitorId).toBeNull();
    expect(await journeys.ingestHits(db, ctx, { ...batch, consent: "granted" }, { consentRequired: true })).toEqual({ accepted: 1, attributed: true, ref: { ttlSeconds: 30 * 86_400 } });
    expect((await journeys.journeyReport(db, ws2.ctx)).funnel.visitors).toBe(1);
  });
});
