import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import * as automation from "../src/services/automation";
import * as conversions from "../src/services/conversions";
import * as commissions from "../src/services/commissions";
import * as affiliatesSvc from "../src/services/affiliates";
import * as messaging from "../src/services/messaging";
import type { DomainEvent } from "../src/services/events";
import { jobs as jobsTable, tenants, type Affiliate } from "../src/db/schema";

let db: Db;
const clock = makeClock();
let ws: Workspace;
let alice: Affiliate;
const email = new messaging.MemoryEmailProvider();
const deps = { email, webUrl: "http://web.test" };

async function lastEvent(type: string): Promise<DomainEvent> {
  const rows = await db.select().from(jobsTable).where(eq(jobsTable.type, "domain_event"));
  const ev = rows.map((r) => r.payload as unknown as DomainEvent).filter((e) => e.type === type && e.tenantId === ws.tenant.id).pop();
  if (!ev) throw new Error(`no ${type} event`);
  return ev;
}

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock);
  await db.update(tenants).set({ planId: "growth" }).where(eq(tenants.id, ws.tenant.id));
  alice = await createActiveAffiliate(db, ws, "Alice");
});
afterAll(closeDb);

describe("automation rules (AUTO-01..06)", () => {
  it("validates rule definitions and gates on plan", async () => {
    await db.update(tenants).set({ planId: "starter" }).where(eq(tenants.id, ws.tenant.id));
    await expect(automation.createRule(db, ws.ctx, { name: "x", trigger: "conversion.created", actions: [{ type: "add_tag", tag: "vip" }] })).rejects.toMatchObject({ code: "plan_limit" });
    await db.update(tenants).set({ planId: "growth" }).where(eq(tenants.id, ws.tenant.id));
    await expect(automation.createRule(db, ws.ctx, { name: "x", trigger: "conversion.created", actions: [] })).rejects.toThrow();
    await expect(automation.createRule(db, ws.ctx, { name: "x", trigger: "nope" as never, actions: [{ type: "add_tag", tag: "vip" }] })).rejects.toThrow();
    await expect(automation.createRule(db, ws.ctx, { name: "x", trigger: "conversion.created", actions: [{ type: "send_custom", subject: "Hi {{bogus}}", body: "x" }] })).rejects.toMatchObject({ code: "validation" });
  });

  it("runs matching rules with conditions, actions and a run log; skips non-matching ones", async () => {
    const big = await automation.createRule(db, ws.ctx, {
      name: "Big sale",
      trigger: "conversion.created",
      conditions: [{ field: "amountMinor", op: "gte", value: 50_000 }, { field: "programId", op: "eq", value: ws.program.id }],
      actions: [
        { type: "add_tag", tag: "big-spender" },
        { type: "create_task", title: "Thank {{affiliate_name}} for a {{amount}} {{currency}} sale" },
        { type: "send_custom", subject: "Great sale, {{affiliate_name}}", body: "You just referred {{amount}} {{currency}} on {{offer_name}}." },
        { type: "approve_commission" },
      ],
    });
    const small = await automation.createRule(db, ws.ctx, { name: "Small sale", trigger: "conversion.created", conditions: [{ field: "amountMinor", op: "lte", value: 1000 }], actions: [{ type: "add_tag", tag: "small" }] });
    const paused = await automation.createRule(db, ws.ctx, { name: "Paused", trigger: "conversion.created", actions: [{ type: "add_tag", tag: "never" }], enabled: false });

    const click = await clickFor(db, ws, alice, clock);
    const res = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "auto-1", offerId: ws.offer.id, amountMinor: 100_000, clickToken: click.token });
    const event = await lastEvent("conversion.created");
    email.sent.length = 0;
    const runs = await automation.runRulesForEvent(db, ws.ctx, event, deps);
    expect(runs.map((r) => [r.ruleId, r.status, r.matched])).toEqual(expect.arrayContaining([[big.id, "success", true], [small.id, "skipped", false]]));
    expect(runs.some((r) => r.ruleId === paused.id)).toBe(false);

    const after = await affiliatesSvc.getAffiliate(db, ws.ctx, alice.id);
    expect(after.tags).toEqual(["big-spender"]);
    const tasksOpen = await automation.listTasks(db, ws.ctx, { status: "open" });
    expect(tasksOpen[0]).toMatchObject({ title: "Thank Alice for a 1000.00 USD sale", affiliateId: alice.id, ruleId: big.id, entityId: res.conversion.id });
    expect(email.sent[0]).toMatchObject({ to: alice.email, subject: "Great sale, Alice" });
    expect(email.sent[0]!.body).toContain("1000.00 USD");
    expect((await commissions.getCommission(db, ws.ctx, res.commission!.id)).status).toBe("approved");
    const bigRun = runs.find((r) => r.ruleId === big.id)!;
    expect((bigRun.actionsTaken as { type: string; ok: boolean }[]).map((a) => [a.type, a.ok])).toEqual([["add_tag", true], ["create_task", true], ["send_custom", true], ["approve_commission", true]]);

    // once per entity: replaying the same event does nothing
    const again = await automation.runRulesForEvent(db, ws.ctx, event, deps);
    expect(again.find((r) => r.ruleId === big.id)).toMatchObject({ status: "skipped", error: "already ran for this entity" });
    expect((await affiliatesSvc.getAffiliate(db, ws.ctx, alice.id)).tags).toEqual(["big-spender"]);

    // events caused by automation are ignored, so approve_commission cannot re-trigger anything
    const approvedEvent = await lastEvent("commission.approved");
    expect(approvedEvent.actor.id).toBe(automation.AUTOMATION_ACTOR);
    expect(await automation.runRulesForEvent(db, ws.ctx, approvedEvent, deps)).toEqual([]);

    // tasks can be completed; rule stats and run log are visible
    await automation.completeTask(db, ws.ctx, tasksOpen[0]!.id);
    expect(await automation.listTasks(db, ws.ctx, { status: "open" })).toHaveLength(0);
    const list = await automation.listRules(db, ws.ctx);
    expect(list.find((r) => r.id === big.id)?.stats).toMatchObject({ runs: 2, succeeded: 1, failed: 0 });
    expect(await automation.listRuns(db, ws.ctx, big.id)).toHaveLength(2);
  });

  it("failed actions are logged without poisoning the run, stop conditions and windows apply", async () => {
    const failing = await automation.createRule(db, ws.ctx, { name: "Approve twice", trigger: "conversion.created", actions: [{ type: "approve_commission" }, { type: "add_tag", tag: "after-failure" }], stop: { oncePerEntity: false } });
    const event = await lastEvent("conversion.created"); // commission already approved by the earlier rule
    const runs = await automation.runRulesForEvent(db, ws.ctx, event, deps);
    const run = runs.find((r) => r.ruleId === failing.id)!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/approve_commission/);
    expect((run.actionsTaken as { ok: boolean }[]).map((a) => a.ok)).toEqual([false]);
    expect((await affiliatesSvc.getAffiliate(db, ws.ctx, alice.id)).tags).not.toContain("after-failure");
    await automation.setRuleEnabled(db, ws.ctx, failing.id, false);

    // once per affiliate and suspended affiliates
    const welcome = await automation.createRule(db, ws.ctx, { name: "Welcome bonus", trigger: "conversion.created", actions: [{ type: "adjust_balance", amountMinor: 1000, reason: "first sale" }], stop: { oncePerEntity: false, oncePerAffiliate: true } });
    const c2 = await clickFor(db, ws, alice, clock);
    await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "auto-2", offerId: ws.offer.id, amountMinor: 500, clickToken: c2.token });
    const e2 = await lastEvent("conversion.created");
    let r = await automation.runRulesForEvent(db, ws.ctx, e2, deps);
    expect(r.find((x) => x.ruleId === welcome.id)?.status).toBe("success");
    expect(r.find((x) => x.ruleId === failing.id)).toBeUndefined(); // disabled
    r = await automation.runRulesForEvent(db, ws.ctx, e2, deps);
    expect(r.find((x) => x.ruleId === welcome.id)).toMatchObject({ status: "skipped", error: "already ran for this affiliate" });
    expect((await commissions.listLedger(db, ws.ctx, alice.id)).filter((l) => l.type === "adjustment")).toHaveLength(1);

    // window in the future: skipped
    const future = await automation.createRule(db, ws.ctx, { name: "Later", trigger: "conversion.created", actions: [{ type: "add_tag", tag: "later" }], stop: { activeFrom: new Date(clock.now().getTime() + 86_400_000) } });
    r = await automation.runRulesForEvent(db, ws.ctx, e2, deps);
    expect(r.find((x) => x.ruleId === future.id)).toMatchObject({ status: "skipped", error: "before active window" });

    // suspended affiliate: everything skipped
    await affiliatesSvc.suspendAffiliate(db, ws.ctx, alice.id, "test");
    const c3 = await clickFor(db, ws, alice, clock).catch(() => null);
    expect(c3).toBeNull(); // suspended affiliates cannot even be clicked through
    const suspendedEvent = { ...e2, entityId: "cnv_fake", data: { ...e2.data, affiliateId: alice.id } } as DomainEvent;
    r = await automation.runRulesForEvent(db, ws.ctx, suspendedEvent, deps);
    expect(r.every((x) => x.status === "skipped" && x.error === "affiliate is suspended")).toBe(true);
  });
});
