import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { tenantContext, systemContext } from "../src/context";
import * as notifications from "../src/services/notifications";
import * as conversions from "../src/services/conversions";
import * as affiliates from "../src/services/affiliates";
import * as tenants from "../src/services/tenants";
import * as automation from "../src/services/automation";
import * as retention from "../src/services/retention";
import * as jobsSvc from "../src/services/jobs";
import { withTenantScope } from "../src/db/rls";
import { jobs as jobsTable, tenants as tenantsTable, users, type Notification } from "../src/db/schema";
import type { DomainEvent } from "../src/services/events";

let db: Db;
const clock = makeClock("2026-02-01T00:00:00Z");
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock, { programOverrides: { approvalMode: "manual", holdingDays: 0 } });
  await db.update(tenantsTable).set({ planId: "growth" }).where(eq(tenantsTable.id, ws.tenant.id));
});
afterAll(closeDb);

/** Drain the domain-event jobs the services enqueued and hand each event to the fan-out, the way the worker does. */
async function fanOutPending(): Promise<Notification[]> {
  const out: Notification[] = [];
  const handlers = {
    domain_event: async (job: { payload: Record<string, unknown> }) => {
      const event = job.payload as unknown as DomainEvent;
      if (event.tenantId !== ws.tenant.id) return;
      out.push(...(await withTenantScope(db, ws.tenant.id, (tx) => notifications.fanOutForEvent(tx, systemContext(ws.tenant.id, clock.now), event))));
    },
  };
  await jobsSvc.runDueJobs(db, handlers, clock.now());
  return out;
}

describe("notification centre", () => {
  it("has a category catalogue per audience and email categories that map onto the built-in emails", () => {
    expect(notifications.categoriesFor("merchant").map((c) => c.key)).toEqual(["applications", "sales", "disputes", "payouts", "tasks"]);
    expect(notifications.categoriesFor("affiliate").every((c) => c.email)).toBe(true);
    for (const cat of Object.values(notifications.EMAIL_CATEGORY)) expect(notifications.CATEGORIES.some((c) => c.key === cat && c.audience === "affiliate")).toBe(true);
    expect(notifications.wants(null, "sales", "inApp")).toBe(true);
    expect(notifications.wants({ sales: { inApp: false } }, "sales", "inApp")).toBe(false);
    expect(notifications.wants({ sales: { inApp: false } }, "sales", "email")).toBe(true);
  });

  it("an application notifies owners, admins and marketing but not read-only members; approval notifies the affiliate", async () => {
    await tenants.addTeamMember(db, ws.ctx, { name: "Mia", email: "mia-n@example.com", password: "password123", role: "marketing" });
    await tenants.addTeamMember(db, ws.ctx, { name: "Ro", email: "ro-n@example.com", password: "password123", role: "readonly" });
    const publicCtx = tenantContext(ws.tenant.id, { type: "public" }, clock.now);
    const { affiliate } = await affiliates.applyToProgram(db, publicCtx, ws.program.id, { name: "Nia", email: "nia-n@example.com", password: "password123", acceptTerms: true });
    const created = await fanOutPending();
    const applied = created.filter((n) => n.type === "affiliate.applied");
    expect(applied.map((n) => n.recipientType)).toEqual(["user", "user"]); // owner + marketing
    expect(applied[0]!.title).toBe(`Nia applied to ${ws.program.name}`);
    expect(applied[0]!.link).toBe(`/app/affiliates/${affiliate.id}`);
    expect(applied[0]!.category).toBe("applications");
    const ro = await db.query.users.findFirst({ where: eq(users.email, "ro-n@example.com") });
    expect(await notifications.unreadCount(db, ws.ctx, { type: "user", id: ro!.id })).toBe(0);

    await affiliates.approveAffiliate(db, ws.ctx, affiliate.id);
    const approved = (await fanOutPending()).filter((n) => n.type === "affiliate.approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ recipientType: "affiliate", recipientId: affiliate.id, category: "account", link: "/portal/links" });
  });

  it("a sale notifies the team and the affiliate; listing, unread counts and mark-read are scoped to the recipient", async () => {
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token } = await clickFor(db, ws, alice, clock);
    await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "ntf-1", offerId: ws.offer.id, amountMinor: 12_345, clickToken: token });
    const created = await fanOutPending();
    const sale = created.filter((n) => n.type === "conversion.created");
    expect(sale.find((n) => n.recipientType === "affiliate")).toMatchObject({ recipientId: alice.id, category: "earnings", title: "A sale was attributed to you", body: `123.45 USD · ${ws.offer.name}`, link: "/portal/conversions" });
    expect(sale.find((n) => n.recipientType === "user" && n.recipientId === ws.owner.id)).toMatchObject({ category: "sales", title: "Sale attributed to Alice", link: "/app/conversions" });

    const affCtx = tenantContext(ws.tenant.id, { type: "affiliate", id: alice.id, affiliateId: alice.id, role: "affiliate" }, clock.now);
    const mine = await notifications.listNotifications(db, affCtx, { type: "affiliate", id: alice.id });
    expect(mine.every((n) => n.recipientId === alice.id)).toBe(true);
    expect(await notifications.unreadCount(db, affCtx, { type: "affiliate", id: alice.id })).toBe(mine.length);
    // an affiliate cannot read another affiliate's feed
    await expect(notifications.listNotifications(db, affCtx, { type: "affiliate", id: "aff_other" })).rejects.toThrow(/scope/);
    // marking someone else's id is a no-op
    const ownerUnread = await notifications.listNotifications(db, ws.ctx, { type: "user", id: ws.owner.id }, { unreadOnly: true });
    expect(await notifications.markRead(db, affCtx, { type: "affiliate", id: alice.id }, { ids: [ownerUnread[0]!.id] })).toBe(0);
    expect(await notifications.markRead(db, affCtx, { type: "affiliate", id: alice.id }, { ids: [mine[0]!.id] })).toBe(1);
    expect(await notifications.unreadCount(db, affCtx, { type: "affiliate", id: alice.id })).toBe(mine.length - 1);
    expect(await notifications.markRead(db, ws.ctx, { type: "user", id: ws.owner.id }, { all: true })).toBe(ownerUnread.length);
    expect(await notifications.unreadCount(db, ws.ctx, { type: "user", id: ws.owner.id })).toBe(0);
    expect(await notifications.markRead(db, ws.ctx, { type: "user", id: ws.owner.id }, {})).toBe(0);
  });

  it("preferences switch categories off per recipient and are limited to the recipient's own categories", async () => {
    const view = await notifications.getPrefs(db, ws.ctx, { type: "user", id: ws.owner.id });
    expect(view.audience).toBe("merchant");
    expect(view.categories.map((c) => c.key)).toContain("disputes");
    await notifications.updatePrefs(db, ws.ctx, { type: "user", id: ws.owner.id }, { sales: { inApp: false }, account: { inApp: false }, bogus: { inApp: false } });
    const after = await notifications.getPrefs(db, ws.ctx, { type: "user", id: ws.owner.id });
    expect(after.prefs).toEqual({ sales: { inApp: false } });
    const bob = await createActiveAffiliate(db, ws, "Bob");
    const { token } = await clickFor(db, ws, bob, clock);
    await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "ntf-2", offerId: ws.offer.id, amountMinor: 5_000, clickToken: token });
    const created = (await fanOutPending()).filter((n) => n.type === "conversion.created");
    expect(created.some((n) => n.recipientId === ws.owner.id)).toBe(false);
    expect(created.some((n) => n.recipientId === bob.id)).toBe(true);
    // turning it back on removes the key entirely
    await notifications.updatePrefs(db, ws.ctx, { type: "user", id: ws.owner.id }, { sales: { inApp: true } });
    expect((await notifications.getPrefs(db, ws.ctx, { type: "user", id: ws.owner.id })).prefs).toEqual({});
    // marketing members only see their categories
    const mia = await db.query.users.findFirst({ where: eq(users.email, "mia-n@example.com") });
    const miaView = await notifications.getPrefs(db, tenantContext(ws.tenant.id, { type: "user", id: mia!.id, role: "marketing" }, clock.now), { type: "user", id: mia!.id });
    expect(miaView.categories.map((c) => c.key)).toEqual(["applications", "sales", "tasks"]);
    // affiliate email preference
    const affCtx = tenantContext(ws.tenant.id, { type: "affiliate", id: bob.id, affiliateId: bob.id, role: "affiliate" }, clock.now);
    await notifications.updatePrefs(db, affCtx, { type: "affiliate", id: bob.id }, { earnings: { email: false } });
    const bobRow = await affiliates.getAffiliate(db, ws.ctx, bob.id);
    expect(notifications.wants(bobRow.notificationPrefs, "earnings", "email")).toBe(false);
    expect(notifications.wants(bobRow.notificationPrefs, "earnings", "inApp")).toBe(true);
    await expect(notifications.updatePrefs(db, affCtx, { type: "affiliate", id: "aff_other" }, {})).rejects.toThrow(/scope/);
  });

  it("new tasks notify the team, and retention prunes old notifications", async () => {
    const before = await notifications.unreadCount(db, ws.ctx, { type: "user", id: ws.owner.id });
    await automation.createTask(db, ws.ctx, { title: "Check the thing", note: "details" });
    const list = await notifications.listNotifications(db, ws.ctx, { type: "user", id: ws.owner.id }, { unreadOnly: true, limit: 5 });
    expect(list[0]).toMatchObject({ type: "task", category: "tasks", title: "New task: Check the thing", body: "details", link: "/app" });
    expect(await notifications.unreadCount(db, ws.ctx, { type: "user", id: ws.owner.id })).toBe(before + 1);

    clock.advanceDays(200);
    const policy = retention.effectivePolicy(ws.tenant);
    const preview = await retention.previewPrune(db, ws.ctx, policy, clock.now());
    expect(preview.notificationsDays).toBeGreaterThan(0);
    const counts = await withTenantScope(db, ws.tenant.id, (tx) => retention.pruneTenant(tx, systemContext(ws.tenant.id, clock.now), policy, clock.now()));
    expect(counts.notificationsDays).toBe(preview.notificationsDays);
    expect(await notifications.unreadCount(db, ws.ctx, { type: "user", id: ws.owner.id })).toBe(0);
    expect(await db.query.jobs.findFirst({ where: eq(jobsTable.tenantId, ws.tenant.id) })).toBeTruthy();
  });
});
