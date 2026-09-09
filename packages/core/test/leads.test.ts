import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { tenantContext, systemContext } from "../src/context";
import * as leads from "../src/services/leads";
import * as programs from "../src/services/programs";
import * as conversions from "../src/services/conversions";
import * as commissions from "../src/services/commissions";
import * as analytics from "../src/services/analytics";
import * as retention from "../src/services/retention";
import * as tracking from "../src/services/tracking";
import { withTenantScope } from "../src/db/rls";
import { programs as programsTable } from "../src/db/schema";

let db: Db;
const clock = makeClock("2026-03-01T00:00:00Z");
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock, { programOverrides: { approvalMode: "auto", holdingDays: 7 } });
  await programs.updateProgram(db, ws.ctx, ws.program.id, { leadsEnabled: true, leadCommissionMinor: 1_500, leadApproval: "manual", leadDedupeDays: 30 });
  ws.program = await programs.getProgram(db, ws.ctx, ws.program.id);
});
afterAll(closeDb);

describe("leads intake", () => {
  it("enabling leads on a program mints a capture token; the token resolves the program", async () => {
    expect(ws.program.leadsEnabled).toBe(true);
    expect(ws.program.leadCaptureToken).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect((await leads.getProgramByCaptureToken(db, ws.program.leadCaptureToken!))?.id).toBe(ws.program.id);
    expect(await leads.getProgramByCaptureToken(db, "nope")).toBeNull();
    const again = await programs.updateProgram(db, ws.ctx, ws.program.id, { leadCommissionMinor: 2_000 });
    expect(again.leadCaptureToken).toBe(ws.program.leadCaptureToken); // stable across edits
    await programs.updateProgram(db, ws.ctx, ws.program.id, { leadCommissionMinor: 1_500 });
  });

  it("a lead through a click is attributed like a sale, earns the fixed lead amount as a pending commission, and stays pending until qualified", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token } = await clickFor(db, ws, alice, clock);
    const result = await leads.recordLead(db, ws.ctx, { source: "form", name: "Lee Lead", email: "Lee@Example.com", phone: "+15551234567", fields: { budget: "5k" }, clickToken: token, landingUrl: "https://acme.example.com/landing?ref=x" });
    expect(result.duplicate).toBe(false);
    expect(result.disposition).toBeNull();
    expect(result.commissionMinor).toBe(1_500);
    expect(result.lead.email).toBe("lee@example.com");
    expect(result.lead.affiliateId).toBe(alice.id);
    expect(result.lead.programId).toBe(ws.program.id);
    const conv = await conversions.getConversion(db, ws.ctx, result.lead.conversionId);
    expect(conv.kind).toBe("lead");
    expect(conv.amountMinor).toBe(0);
    expect(conv.status).toBe("pending");
    const com = await conversions.currentCommission(db, conv.id);
    expect(com?.status).toBe("pending");
    expect(com?.calculationBasis).toMatchObject({ model: "fixed", fixedMinor: 1_500 });

    // it is a lead, not a sale: sales lists and analytics leave it out
    expect((await conversions.listConversions(db, ws.ctx)).some((c) => c.id === conv.id)).toBe(false);
    expect((await conversions.listConversions(db, ws.ctx, { kind: "lead" })).some((c) => c.id === conv.id)).toBe(true);
    const period = { from: new Date(clock.now().getTime() - 86_400_000), to: new Date(clock.now().getTime() + 86_400_000) };
    const overview = await analytics.overview(db, ws.ctx, period);
    expect(overview.conversions).toBe(0);

    // qualification approves the conversion and the commission; the holding period runs from the lead
    const qualified = await leads.qualifyLead(db, ws.ctx, result.lead.id, { note: "called them back" });
    expect(qualified.disposition).toBe("qualified");
    expect((await conversions.getConversion(db, ws.ctx, conv.id)).status).toBe("approved");
    expect((await conversions.currentCommission(db, conv.id))?.status).toBe("approved");
    clock.advanceDays(8);
    const settled = await commissions.settleHoldingPeriods(db, ws.ctx, clock.now());
    expect(settled.some((c) => c.conversionId === conv.id && c.status === "payable")).toBe(true);
    // idempotent
    expect((await leads.qualifyLead(db, ws.ctx, result.lead.id)).disposition).toBe("qualified");
  });

  it("a second lead with the same email inside the dedupe window is a duplicate and earns nothing; outside the window it counts", async () => {
    const bob = await createActiveAffiliate(db, ws, "Bob");
    const { token } = await clickFor(db, ws, bob, clock);
    const first = await leads.recordLead(db, ws.ctx, { source: "api", email: "dupe@example.com", clickToken: token, externalLeadId: "L-1" });
    expect(first.disposition).toBeNull();
    const again = await leads.recordLead(db, ws.ctx, { source: "api", email: "dupe@example.com", clickToken: token, externalLeadId: "L-1" });
    expect(again.duplicate).toBe(true); // same external id: same record
    expect(again.lead.id).toBe(first.lead.id);
    const second = await leads.recordLead(db, ws.ctx, { source: "api", email: "DUPE@example.com", clickToken: token, externalLeadId: "L-2" });
    expect(second.disposition).toBe("duplicate");
    expect(second.commissionMinor).toBe(0);
    expect((await conversions.getConversion(db, ws.ctx, second.lead.conversionId)).status).toBe("cancelled");
    expect((await conversions.currentCommission(db, second.lead.conversionId))?.status).toBe("void");
    clock.advanceDays(31);
    const { token: later } = await clickFor(db, ws, bob, clock);
    const third = await leads.recordLead(db, ws.ctx, { source: "api", email: "dupe@example.com", clickToken: later, externalLeadId: "L-3" });
    expect(third.disposition).toBeNull();
    expect(third.commissionMinor).toBe(1_500);
  });

  it("disqualifying voids the commission; a disqualified lead cannot be qualified; a reason is required", async () => {
    const carol = await createActiveAffiliate(db, ws, "Carol");
    const { token } = await clickFor(db, ws, carol, clock);
    const lead = await leads.recordLead(db, ws.ctx, { source: "api", email: "spam@example.com", clickToken: token });
    await expect(leads.disqualifyLead(db, ws.ctx, lead.lead.id, { note: "" })).rejects.toThrow(/reason/);
    const dq = await leads.disqualifyLead(db, ws.ctx, lead.lead.id, { note: "spam" });
    expect(dq.disposition).toBe("disqualified");
    expect((await conversions.currentCommission(db, lead.lead.conversionId))?.status).toBe("void");
    await expect(leads.qualifyLead(db, ws.ctx, lead.lead.id)).rejects.toThrow(/already/);
    // and an already-qualified lead can still be disqualified later (reversal)
    const { token: t2 } = await clickFor(db, ws, carol, clock);
    const good = await leads.recordLead(db, ws.ctx, { source: "api", email: "later-bad@example.com", clickToken: t2 });
    await leads.qualifyLead(db, ws.ctx, good.lead.id);
    const rev = await leads.disqualifyLead(db, ws.ctx, good.lead.id, { note: "turned out to be a bot" });
    expect(rev.disposition).toBe("disqualified");
    expect((await conversions.currentCommission(db, good.lead.conversionId))?.status).toBe("reversed");
  });

  it("auto-qualification, manual attribution with a reason, unattributed leads, and a program that does not accept leads", async () => {
    await programs.updateProgram(db, ws.ctx, ws.program.id, { leadApproval: "auto" });
    const dan = await createActiveAffiliate(db, ws, "Dan");
    await tracking.createCouponCode(db, ws.ctx, { affiliateId: dan.id, programId: ws.program.id, code: "DAN10" });
    const auto = await leads.recordLead(db, ws.ctx, { source: "manual", name: "Auto", couponCode: "dan10", programId: ws.program.id });
    expect(auto.disposition).toBe("qualified");
    expect((await conversions.currentCommission(db, auto.lead.conversionId))?.status).toBe("approved");
    await expect(leads.recordLead(db, ws.ctx, { source: "manual", name: "Manual", affiliateId: dan.id, programId: ws.program.id })).rejects.toThrow(/reason/);
    const manual = await leads.recordLead(db, ws.ctx, { source: "manual", name: "Manual", affiliateId: dan.id, programId: ws.program.id, reason: "phone call" });
    expect(manual.lead.affiliateId).toBe(dan.id);
    // no attribution at all: recorded for the merchant, nobody paid
    const orphan = await leads.recordLead(db, ws.ctx, { source: "manual", name: "Walk-in", programId: ws.program.id });
    expect(orphan.lead.affiliateId).toBeNull();
    expect(orphan.commissionMinor).toBe(0);
    expect(orphan.disposition).toBeNull();
    // a program without leads enabled records the lead but pays nothing
    await programs.updateProgram(db, ws.ctx, ws.program.id, { leadsEnabled: false, leadApproval: "manual" });
    const { token } = await clickFor(db, ws, dan, clock);
    const unpaid = await leads.recordLead(db, ws.ctx, { source: "api", email: "unpaid@example.com", clickToken: token });
    expect(unpaid.commissionMinor).toBe(0);
    await programs.updateProgram(db, ws.ctx, ws.program.id, { leadsEnabled: true });
    await expect(leads.recordLead(db, ws.ctx, { source: "api", fields: { x: "y" } })).rejects.toThrow(/name, an email or a phone/);
  });

  it("listing joins names and commissions; the portal view hides contact details; retention blanks settled leads' contacts", async () => {
    const rows = await leads.listLeads(db, ws.ctx, { limit: 50 });
    expect(rows.length).toBeGreaterThan(5);
    const withAff = rows.find((r) => r.lead.affiliateId);
    expect(withAff?.affiliateName).toBeTruthy();
    expect(withAff?.programName).toBe(ws.program.name);
    expect(rows.every((r) => typeof r.conversionStatus === "string")).toBe(true);
    const summary = await leads.leadSummary(db, ws.ctx);
    expect(summary.qualified).toBeGreaterThanOrEqual(2);
    expect(summary.duplicate).toBe(1);
    expect(summary.disqualified).toBe(2);
    expect((await leads.listLeads(db, ws.ctx, { disposition: "pending" })).every((r) => r.lead.disposition === null)).toBe(true);

    const alice = rows.find((r) => r.affiliateName === "Alice")!.lead.affiliateId!;
    const affCtx = tenantContext(ws.tenant.id, { type: "affiliate", id: alice, affiliateId: alice, role: "affiliate" }, clock.now);
    const mine = await leads.listLeadsForAffiliate(db, affCtx, alice);
    expect(mine.length).toBeGreaterThan(0);
    for (const l of mine) {
      expect(l).not.toHaveProperty("email");
      expect(l).not.toHaveProperty("name");
      expect(l.emailDomain).toBe("example.com");
    }
    await expect(leads.listLeadsForAffiliate(db, affCtx, "aff_other")).rejects.toThrow(/scope/);
    const readonly = tenantContext(ws.tenant.id, { type: "user", id: "u", role: "readonly" }, clock.now);
    await expect(leads.qualifyLead(db, readonly, rows[0]!.lead.id)).rejects.toThrow();

    // retention: settled leads older than the window lose their contact fields, pending ones keep them
    clock.advanceDays(400);
    const policy = retention.effectivePolicy(ws.tenant);
    const preview = await retention.previewPrune(db, ws.ctx, policy, clock.now());
    expect(preview.leadsDays).toBeGreaterThan(0);
    const counts = await withTenantScope(db, ws.tenant.id, (tx) => retention.pruneTenant(tx, systemContext(ws.tenant.id, clock.now), policy, clock.now()));
    expect(counts.leadsDays).toBe(preview.leadsDays);
    const after = await leads.listLeads(db, ws.ctx, { limit: 50 });
    expect(after.filter((r) => r.lead.disposition).every((r) => r.lead.erasedAt && r.lead.email === null)).toBe(true);
    expect(after.filter((r) => !r.lead.disposition).every((r) => !r.lead.erasedAt)).toBe(true);
    expect(await db.query.programs.findFirst({ where: eq(programsTable.id, ws.program.id) })).toBeTruthy();
  });
});
