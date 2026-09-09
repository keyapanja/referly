import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db, DbHandle } from "../src/db/client";
import { createTestDb } from "../src/db/client";
import { withTenantScope } from "../src/db/rls";
import { clickFor, closeDb, createActiveAffiliate, createWorkspace, getDb, makeClock, type Workspace } from "./helpers";
import { tenantContext, systemContext } from "../src/context";
import * as backup from "../src/services/backup";
import * as retention from "../src/services/retention";
import * as privacy from "../src/services/privacy";
import * as maintenance from "../src/services/maintenance";
import * as platform from "../src/services/platform";
import * as conversions from "../src/services/conversions";
import * as commissions from "../src/services/commissions";
import * as messaging from "../src/services/messaging";
import * as jobs from "../src/services/jobs";
import * as exportsSvc from "../src/services/exports";
import { affiliates, auditLogs, clicks, commissions as commissionsTable, jobs as jobsTable, messageLogs, sessions, tasks, users } from "../src/db/schema";

let db: Db;
const clock = makeClock("2026-01-10T00:00:00Z");
let ws: Workspace;

beforeAll(async () => {
  db = await getDb();
  ws = await createWorkspace(db, clock, { programOverrides: { approvalMode: "auto", holdingDays: 0 } });
});
afterAll(closeDb);

describe("logical backup and restore", () => {
  let second: DbHandle;
  afterAll(async () => second?.close());

  it("describes tables in foreign-key order with primary keys and self-references", async () => {
    const tables = await backup.describeTables(db);
    const names = tables.map((t) => t.name);
    expect(names).toContain("tenants");
    expect(names.indexOf("tenants")).toBeLessThan(names.indexOf("users"));
    expect(names.indexOf("affiliates")).toBeLessThan(names.indexOf("clicks"));
    expect(names.indexOf("conversions")).toBeLessThan(names.indexOf("commissions"));
    expect(tables.find((t) => t.name === "affiliate_programs")!.pk).toEqual(["affiliate_id", "program_id"]);
    expect(tables.find((t) => t.name === "audit_logs")!.serials).toEqual(["seq"]);
    expect(tables.find((t) => t.name === "jobs")!.hasTenantId).toBe(true);
    expect(tables.find((t) => t.name === "maintenance_runs")!.hasTenantId).toBe(false);
  });

  it("dumps every table as JSON lines and restores it into a fresh database with identical counts and values", async () => {
    // some data with money, json, timestamps, a click → conversion → commission chain and a message
    const alice = await createActiveAffiliate(db, ws, "Alice");
    const { token } = await clickFor(db, ws, alice, clock);
    const conv = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "bk-1", offerId: ws.offer.id, amountMinor: 120_000, clickToken: token });
    expect(conv.commission).toBeTruthy();
    await messaging.sendCustom(db, ws.ctx, new messaging.MemoryEmailProvider(), { to: alice.email, subject: "hello", body: "backup test", affiliateId: alice.id });
    await jobs.enqueueJob(db, { tenantId: ws.tenant.id, type: "noop", payload: { a: 1 } });

    const lines: backup.BackupLine[] = [];
    for await (const line of backup.dumpDatabase(db, { batchSize: 2, now: clock.now })) lines.push(line);
    const header = lines[0] as Extract<backup.BackupLine, { t: "header" }>;
    expect(header.t).toBe("header");
    expect(header.format).toBe(backup.BACKUP_FORMAT);
    expect(header.migrations.length).toBeGreaterThan(10);
    const footer = lines[lines.length - 1] as Extract<backup.BackupLine, { t: "footer" }>;
    expect(footer.t).toBe("footer");
    const sourceCounts = await backup.tableCounts(db);
    const ends = Object.fromEntries(lines.filter((l): l is Extract<backup.BackupLine, { t: "end" }> => l.t === "end").map((l) => [l.table, l.count]));
    expect(ends).toEqual(sourceCounts);
    expect(footer.rows).toBe(Object.values(sourceCounts).reduce((a, b) => a + b, 0));

    second = await createTestDb({ sessionBypass: true });
    const result = await backup.restoreDatabase(second.db, (async function* () {
      for (const l of lines) yield l;
    })());
    expect(result.droppedColumns).toEqual([]);
    expect(result.droppedTables).toEqual([]);
    expect(result.rows).toBe(footer.rows);
    expect(await backup.tableCounts(second.db)).toEqual(sourceCounts);

    // values survive the round trip: money as bigint, jsonb, timestamptz, booleans
    const [srcCom] = await db.select().from(commissionsTable).where(eq(commissionsTable.id, conv.commission!.id));
    const [dstCom] = await second.db.select().from(commissionsTable).where(eq(commissionsTable.id, conv.commission!.id));
    expect(dstCom).toEqual(srcCom);
    const [srcAff] = await db.select().from(affiliates).where(eq(affiliates.id, alice.id));
    const [dstAff] = await second.db.select().from(affiliates).where(eq(affiliates.id, alice.id));
    expect(dstAff).toEqual(srcAff);
    // the serial sequence continues after the highest restored value
    const ctx2 = tenantContext(ws.tenant.id, { type: "system", role: "owner" }, clock.now);
    const beforeMax = Math.max(...(await second.db.select({ seq: auditLogs.seq }).from(auditLogs)).map((r) => r.seq));
    await second.db.insert(auditLogs).values({ id: "aud_after_restore", tenantId: ctx2.tenantId, entityType: "x", entityId: "y", action: "z", actorType: "system" });
    const [inserted] = await second.db.select({ seq: auditLogs.seq }).from(auditLogs).where(eq(auditLogs.id, "aud_after_restore"));
    expect(inserted!.seq).toBeGreaterThan(beforeMax);
  });

  it("refuses an archive of another format version", async () => {
    await expect(
      backup.restoreDatabase(second.db, (async function* () {
        yield { t: "header", format: 99, at: "", migrations: [], tables: [] } as backup.BackupLine;
      })()),
    ).rejects.toThrow(/unsupported backup format/);
  });
});

describe("retention", () => {
  it("has bounded per-category overrides that fall back to the platform defaults", async () => {
    const view = await retention.getRetention(db, ws.ctx);
    expect(view.effective).toEqual(retention.RETENTION_DEFAULTS);
    expect(view.overrides).toEqual({});
    await retention.updateRetention(db, ws.ctx, { clicksDays: 60, messageLogsDays: null });
    const after = await retention.getRetention(db, ws.ctx);
    expect(after.effective.clicksDays).toBe(60);
    expect(after.effective.messageLogsDays).toBe(retention.RETENTION_DEFAULTS.messageLogsDays);
    await expect(retention.updateRetention(db, ws.ctx, { clicksDays: 5 })).rejects.toThrow();
    await expect(retention.updateRetention(db, ws.ctx, { auditLogsDays: 10_000 })).rejects.toThrow();
    const readonly = tenantContext(ws.tenant.id, { type: "user", id: "u", role: "readonly" }, clock.now);
    await expect(retention.updateRetention(db, readonly, { clicksDays: 90 })).rejects.toThrow();
  });

  it("prunes aged rows per tenant under its policy, keeps attributed clicks and the books, and audits the counts", async () => {
    const bob = await createActiveAffiliate(db, ws, "Bob");
    // an old unattributed click, an old attributed click (conversion), a fresh click
    clock.set("2025-01-01T00:00:00Z");
    const oldFree = await clickFor(db, ws, bob, clock);
    const oldAttributed = await clickFor(db, ws, bob, clock);
    const conv = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "ret-1", offerId: ws.offer.id, amountMinor: 10_000, clickToken: oldAttributed.token });
    await messaging.sendCustom(db, ws.ctx, new messaging.MemoryEmailProvider(), { to: bob.email, subject: "old", body: "old mail", affiliateId: bob.id });
    clock.set("2026-01-10T00:00:00Z");
    const fresh = await clickFor(db, ws, bob, clock);

    const policy = (await retention.getRetention(db, ws.ctx)).effective; // clicksDays 60 from the previous test
    expect(policy.clicksDays).toBe(60);
    const preview = await retention.previewPrune(db, ws.ctx, policy, clock.now());
    expect(preview.clicksDays).toBeGreaterThanOrEqual(1);
    expect(preview.messageLogsDays).toBeGreaterThanOrEqual(1);
    expect(preview.auditLogsDays).toBe(0); // 730-day default keeps last year's audit rows

    const counts = await withTenantScope(db, ws.tenant.id, (tx) => retention.pruneTenant(tx, systemContext(ws.tenant.id, clock.now), policy, clock.now()));
    expect(counts.clicksDays).toBe(preview.clicksDays);
    expect(await db.query.clicks.findFirst({ where: eq(clicks.id, oldFree.click.id) })).toBeUndefined();
    expect(await db.query.clicks.findFirst({ where: eq(clicks.id, oldAttributed.click.id) })).toBeTruthy();
    expect(await db.query.clicks.findFirst({ where: eq(clicks.id, fresh.click.id) })).toBeTruthy();
    expect(await db.query.commissions.findFirst({ where: eq(commissionsTable.conversionId, conv.conversion.id) })).toBeTruthy();
    const audit = await db.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, ws.tenant.id), eq(auditLogs.action, "retention_pruned")) });
    expect(audit?.after).toMatchObject({ deleted: { clicksDays: counts.clicksDays } });

    // a second run finds nothing and writes no audit noise
    const before = (await db.select().from(auditLogs).where(and(eq(auditLogs.tenantId, ws.tenant.id), eq(auditLogs.action, "retention_pruned")))).length;
    const again = await withTenantScope(db, ws.tenant.id, (tx) => retention.pruneTenant(tx, systemContext(ws.tenant.id, clock.now), policy, clock.now()));
    expect(Object.values(again).every((v) => v === 0)).toBe(true);
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.tenantId, ws.tenant.id), eq(auditLogs.action, "retention_pruned")))).length).toBe(before);
  });

  it("platform housekeeping removes finished jobs, expired sessions and expired exports", async () => {
    const old = new Date("2025-06-01T00:00:00Z");
    const job = await jobs.enqueueJob(db, { tenantId: ws.tenant.id, type: "noop", runAt: old });
    await jobs.completeJob(db, job.id, old);
    const live = await jobs.enqueueJob(db, { tenantId: ws.tenant.id, type: "noop", runAt: clock.now() });
    await db.insert(sessions).values({ id: "ses_expired", tenantId: ws.tenant.id, userId: ws.owner.id, tokenHash: "x".repeat(20), expiresAt: old, createdAt: old });
    const exp = await exportsSvc.requestExport(db, ws.ctx, { entity: "affiliates" });
    await exportsSvc.markExportDone(db, ws.ctx, exp.id, { storageKey: "private/x.csv", rowCount: 0, sizeBytes: 0 });
    clock.advanceDays(30);
    const result = await retention.prunePlatform(db, clock.now(), { jobsDays: 30, closedTenantPurgeDays: 30, maintenanceRunsDays: 365 });
    expect(result.jobs).toBeGreaterThanOrEqual(1);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.exports.map((e) => e.storageKey)).toContain("private/x.csv");
    expect(await db.query.jobs.findFirst({ where: eq(jobsTable.id, live.id) })).toBeTruthy();
    clock.set("2026-01-10T00:00:00Z");
  });
});

describe("data-subject requests", () => {
  it("an affiliate can request erasure once; the team gets a task", async () => {
    const carol = await createActiveAffiliate(db, ws, "Carol");
    const affCtx = tenantContext(ws.tenant.id, { type: "affiliate", id: carol.id, affiliateId: carol.id, role: "affiliate" }, clock.now);
    const task = await privacy.requestErasure(db, affCtx, carol.id);
    expect(task.entityType).toBe("erasure_request");
    const again = await privacy.requestErasure(db, affCtx, carol.id);
    expect(again.id).toBe(task.id);
    const other = await createActiveAffiliate(db, ws, "Dan");
    await expect(privacy.requestErasure(db, affCtx, other.id)).rejects.toThrow(/scope/);
  });

  it("erasure replaces personal data, disables the login, blanks messages and audit snapshots, keeps the ledger, and refuses while money is owed", async () => {
    const eve = await createActiveAffiliate(db, ws, "Eve");
    const { token } = await clickFor(db, ws, eve, clock);
    const conv = await conversions.recordConversion(db, ws.ctx, { source: "webhook", externalOrderId: "erase-1", offerId: ws.offer.id, amountMinor: 50_000, clickToken: token });
    await messaging.sendCustom(db, ws.ctx, new messaging.MemoryEmailProvider(), { to: eve.email, subject: "personal", body: "Dear Eve", affiliateId: eve.id });
    await expect(privacy.eraseAffiliate(db, ws.ctx, eve.id)).rejects.toThrow(/owed/);
    await commissions.reverseCommission(db, ws.ctx, conv.commission!.id, "test", { asVoid: true });

    const erased = await privacy.eraseAffiliate(db, ws.ctx, eve.id, { reason: "GDPR request" });
    expect(erased.name).toBe(privacy.ERASED_NAME);
    expect(erased.email).toBe(privacy.erasedEmail(eve.id));
    expect(erased.phone).toBeNull();
    expect(erased.status).toBe("suspended");
    expect(erased.erasedAt).toBeTruthy();
    const [msg] = await db.select().from(messageLogs).where(and(eq(messageLogs.affiliateId, eve.id), eq(messageLogs.tenantId, ws.tenant.id)));
    expect(msg!.body).toBeNull();
    expect(msg!.recipient).toBe("[erased]");
    const snapshots = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "affiliate"), eq(auditLogs.entityId, eve.id), eq(auditLogs.tenantId, ws.tenant.id)));
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots.filter((s) => s.action !== "erased").every((s) => JSON.stringify(s.after ?? {}).includes("Eve") === false)).toBe(true);
    // the ledger is untouched
    const [com] = await db.select().from(commissionsTable).where(eq(commissionsTable.id, conv.commission!.id));
    expect(com!.affiliateId).toBe(eve.id);
    // idempotent
    expect((await privacy.eraseAffiliate(db, ws.ctx, eve.id)).erasedAt).toEqual(erased.erasedAt);
    // a marketing user cannot erase
    const marketing = tenantContext(ws.tenant.id, { type: "user", id: "u", role: "marketing" }, clock.now);
    await expect(privacy.eraseAffiliate(db, marketing, eve.id)).rejects.toThrow();
  });

  it("the workspace export contains every table but no credentials, hashes or one-time tokens", async () => {
    const seen = new Map<string, Record<string, unknown>[]>();
    for await (const page of privacy.iterateWorkspaceRows(db, ws.ctx, 3)) seen.set(page.table, [...(seen.get(page.table) ?? []), ...page.rows]);
    expect(seen.get("tenants")).toHaveLength(1);
    expect(seen.get("affiliates")!.length).toBeGreaterThan(2);
    expect(seen.has("sessions")).toBe(false);
    expect(seen.has("auth_tokens")).toBe(false);
    expect(seen.has("invites")).toBe(false);
    for (const [, rows] of seen) for (const row of rows) for (const k of Object.keys(row)) expect(["passwordHash", "tokenHash", "keyHash", "secretEnc", "credentialsEnc", "ipHash", "customerEmailHash"]).not.toContain(k);
    expect(seen.get("users")![0]).toHaveProperty("email");
    const readonly = tenantContext(ws.tenant.id, { type: "user", id: "u", role: "admin" }, clock.now);
    await expect(privacy.iterateWorkspaceRows(db, readonly).next()).rejects.toThrow();
    await expect(exportsSvc.requestExport(db, readonly, { entity: "workspace" })).rejects.toThrow();
    expect(exportsSvc.exportFileMeta("workspace").extension).toBe("jsonl");
    expect(exportsSvc.exportFileMeta("clicks").extension).toBe("csv");
  });

  it("closing a workspace starts the purge clock; purge removes every row of the tenant and nothing else", async () => {
    const doomed = await createWorkspace(db, clock, { programOverrides: { approvalMode: "auto" } });
    const frank = await createActiveAffiliate(db, doomed, "Frank");
    await clickFor(db, doomed, frank, clock);
    await jobs.enqueueJob(db, { tenantId: doomed.tenant.id, type: "noop" });
    const admin = { userId: ws.owner.id };
    const closed = await platform.updateTenantByAdmin(db, admin, doomed.tenant.id, { status: "closed", reason: "left" }, clock.now());
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toEqual(clock.now());
    expect(await privacy.closedTenantsBefore(db, clock.now())).toEqual([]);
    const reopened = await platform.updateTenantByAdmin(db, admin, doomed.tenant.id, { status: "active" }, clock.now());
    expect(reopened.closedAt).toBeNull();
    await platform.updateTenantByAdmin(db, admin, doomed.tenant.id, { status: "closed" }, clock.now());
    clock.advanceDays(31);
    expect((await privacy.closedTenantsBefore(db, new Date(clock.now().getTime() - 30 * 86_400_000))).map((t) => t.id)).toEqual([doomed.tenant.id]);

    const before = await backup.tableCounts(db);
    const deleted = await backup.purgeTenantRows(db, doomed.tenant.id);
    expect(deleted.tenants).toBe(1);
    expect(deleted.affiliates).toBe(1);
    expect(deleted.clicks).toBe(1);
    expect(deleted.jobs).toBeGreaterThanOrEqual(1);
    const after = await backup.tableCounts(db);
    for (const [table, n] of Object.entries(before)) expect(after[table]).toBe(n - (deleted[table] ?? 0));
    expect(await db.query.users.findFirst({ where: eq(users.tenantId, doomed.tenant.id) })).toBeUndefined();
    expect(await db.query.affiliates.findFirst({ where: eq(affiliates.id, ws.tenant.id) })).toBeUndefined();
    expect((await db.select().from(affiliates).where(eq(affiliates.tenantId, ws.tenant.id))).length).toBeGreaterThan(0);
    clock.set("2026-01-10T00:00:00Z");
  });

  it("maintenance runs record start, success and failure, and stale running rows are failed", async () => {
    const run = await maintenance.startRun(db, "backup", "manual", clock.now());
    expect((await maintenance.lastRun(db, "backup"))?.id).toBe(run.id);
    expect(await maintenance.lastSuccessful(db, "backup")).toBeNull();
    await maintenance.finishRun(db, run.id, { storageKey: "private/backups/x.rbk", sizeBytes: 123, summary: { rows: 5 } }, clock.now());
    expect((await maintenance.lastSuccessful(db, "backup"))?.sizeBytes).toBe(123);
    const stale = await maintenance.startRun(db, "retention", "scheduled", new Date(clock.now().getTime() - 10 * 3_600_000));
    expect(await maintenance.failStaleRuns(db, new Date(clock.now().getTime() - 6 * 3_600_000))).toBe(1);
    expect((await maintenance.getRun(db, stale.id))?.status).toBe("failed");
    const ops = await platform.opsSummary(db, clock.now());
    expect(ops.maintenance.backup?.status).toBe("done");
    expect(ops.maintenance.retention?.status).toBe("failed");
    const open = await db.select().from(tasks).where(eq(tasks.tenantId, ws.tenant.id));
    expect(open.length).toBeGreaterThan(0);
  });
});
