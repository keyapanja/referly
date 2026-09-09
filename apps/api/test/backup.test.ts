import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, messaging, platform, withRlsBypass, maintenance, jobs, backup as backupSvc, type DbHandle } from "@referly/core";
import { createApp, type App } from "../src/app";
import { runOnce } from "../src/worker";
import { resetRateLimits } from "../src/lib/ratelimit";
import { LocalStorage, PRIVATE_PREFIX } from "../src/storage";
import { BACKUP_PREFIX, backupKeyFor, backupTimestamp, decodeArchive, encodeArchive, inspectArchive, isArchive, listBackups, restoreArchive, rotateBackups, type BackupConfig } from "../src/backup";
import { createLogger } from "../src/lib/log";

/**
 * Backups, retention and data requests over the worker and HTTP: an encrypted archive that
 * restores into an empty database with identical counts and files; rotation; the scheduler
 * enqueuing what is due; the admin maintenance endpoints; per-workspace retention settings;
 * affiliate erasure; the workspace export; and purge of a closed workspace.
 */
let handle: DbHandle;
let storage: LocalStorage;
let app: App;
let clock = new Date("2026-05-01T10:00:00Z");
const now = () => new Date(clock);
const email = new messaging.MemoryEmailProvider();
const quiet = createLogger({ level: "error", write: () => {} });
const key = createHash("sha256").update("test-backup-key-0123456789").digest();
const backupConfig: BackupConfig = { everyHours: 24, keepDays: 14, keepWeeks: 8, includeFiles: true, key, retentionEveryHours: 24 };
const platformRetention = { jobsDays: 30, closedTenantPurgeDays: 30, maintenanceRunsDays: 365 };
const BASE = "http://api.test";
const workerDeps = () => ({ db: handle.db, email, storage, webUrl: "http://web.test", now, backup: backupConfig, platformRetention, log: quiet });

beforeAll(async () => {
  handle = await createTestDb();
  storage = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-backup-")), BASE);
  app = createApp({ db: handle.db, email, storage, backup: backupConfig, platformRetention, log: quiet, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
  resetRateLimits();
});
afterAll(() => handle.close());

async function call<T = any>(p: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<{ status: number; body: T; headers: Headers; raw: string }> {
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
  return { status: res.status, body, headers: res.headers, raw: text };
}

describe("archive format", () => {
  it("round-trips lines through gzip and AES-GCM, and rejects the wrong key or a tampered file", async () => {
    const lines = [{ t: "header", format: 1 }, { t: "row", r: [1, "two", null, { three: 3 }] }];
    const archive = await encodeArchive((async function* () {
      for (const l of lines) yield l;
    })(), key);
    expect(isArchive(archive)).toBe(true);
    const back = [];
    for await (const l of decodeArchive(archive, key)) back.push(l);
    expect(back).toEqual(lines);
    const wrong = createHash("sha256").update("other").digest();
    await expect((async () => { for await (const _ of decodeArchive(archive, wrong)) void _; })()).rejects.toThrow(/wrong BACKUP_KEY|decrypted/);
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await expect((async () => { for await (const _ of decodeArchive(tampered, key)) void _; })()).rejects.toThrow();
    await expect((async () => { for await (const _ of decodeArchive(new TextEncoder().encode("not an archive at all, really"), key)) void _; })()).rejects.toThrow(/not a Referly backup/);
  });

  it("names archives by timestamp and rotates daily then weekly", async () => {
    const at = new Date("2026-05-01T02:03:04.005Z");
    const k = backupKeyFor(at);
    expect(k).toBe(`${BACKUP_PREFIX}2026-05-01T02-03-04-005Z.rbk`);
    expect(backupTimestamp(k)).toEqual(at);
    const dir = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-rotate-")), BASE);
    const today = new Date("2026-05-01T00:00:00Z");
    const days = [0, 1, 5, 13, 14, 15, 16, 20, 21, 27, 28, 40, 60, 70, 71, 72];
    for (const d of days) await dir.put(backupKeyFor(new Date(today.getTime() - d * 86_400_000)), new Uint8Array([1]), "application/octet-stream", { private: true });
    const removed = await rotateBackups(dir, { keepDays: 14, keepWeeks: 8 }, today);
    const left = (await listBackups(dir)).map((b) => Math.round((today.getTime() - backupTimestamp(b.key)!.getTime()) / 86_400_000));
    // everything within 14 days stays; older ones collapse to one per ISO week; beyond 14 + 56 days gone
    expect(left).toEqual(expect.arrayContaining([0, 1, 5, 13, 14]));
    expect(left.filter((d) => d <= 14)).toHaveLength(5);
    expect(left).not.toContain(71);
    expect(left).not.toContain(72);
    expect(removed.length).toBe(days.length - left.length);
    // 15 and 16 days ago fall in the same ISO week: one survives
    expect(left.filter((d) => d === 15 || d === 16)).toHaveLength(1);
    expect(left.filter((d) => d === 20 || d === 21)).toHaveLength(1);
  });
});

describe("backup, restore and retention over the worker and HTTP", () => {
  let ownerToken: string;
  let adminToken: string;
  let affiliateToken: string;
  let affiliateId: string;
  let programId: string;
  let tenantId: string;
  let backupRunId: string;
  let backupKey: string;

  it("sets up a workspace with an affiliate, an uploaded file and a platform admin", async () => {
    const signup = await call("/v1/auth/signup", { method: "POST", json: { name: "Backup Co", slug: "backup-co", currency: "USD", owner: { name: "Bea", email: "bea@backup.co", password: "supersecret1" } } });
    expect(signup.status).toBe(201);
    ownerToken = signup.body.token;
    tenantId = (await call("/v1/tenant", { token: ownerToken })).body.tenant.id;
    const offer = await call("/v1/offers", { method: "POST", token: ownerToken, json: { name: "Course", priceMinor: 20_000, salesUrl: "https://backup.co/course" } });
    await call(`/v1/offers/${offer.body.offer.id}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const program = await call("/v1/programs", { method: "POST", token: ownerToken, json: { name: "Partners", commissionModel: "percentage", commissionPercent: 10, holdingDays: 0, attributionWindowDays: 30, refundPolicy: "full", offerIds: [offer.body.offer.id], approvalMode: "auto", termsText: "Be nice." } });
    expect(program.status).toBe(201);
    programId = program.body.program.id;
    await call(`/v1/programs/${programId}/status`, { method: "POST", token: ownerToken, json: { status: "active" } });
    const invite = await call("/v1/affiliates/invites", { method: "POST", token: ownerToken, json: { programId, email: "pat@partner.io", name: "Pat" } });
    expect(invite.status).toBe(201);
    const accept = await call(`/invite/${invite.body.invite.token}/accept`, { method: "POST", json: { name: "Pat Partner", password: "partnerpass1", acceptTerms: true } });
    expect(accept.status).toBe(201);
    affiliateToken = accept.body.token;
    affiliateId = accept.body.affiliate.id;
    await storage.put(`tenants/${tenantId}/assets/logo.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), "image/png");
    await withRlsBypass(handle.db, (tx) => platform.ensurePlatformAdmin(tx, { email: "root@platform.test", password: "rootpass123" }, now()));
    adminToken = (await call("/v1/auth/login", { method: "POST", json: { email: "root@platform.test", password: "rootpass123" } })).body.token;
    await runOnce(workerDeps());
  });

  it("the maintenance tick enqueues a backup and a retention prune when none has run; the worker performs both and records them", async () => {
    await jobs.enqueueJob(handle.db, { type: "maintenance", runAt: now() });
    await runOnce(workerDeps());
    const queued = await withRlsBypass(handle.db, (tx) => tx.query.jobs.findMany());
    expect(queued.map((j) => j.type)).toEqual(expect.arrayContaining(["backup_run", "retention_prune"]));
    clock = new Date(clock.getTime() + 120_000);
    await runOnce(workerDeps());
    const runs = await withRlsBypass(handle.db, (tx) => maintenance.listRuns(tx));
    const backupRun = runs.find((r) => r.kind === "backup");
    const retentionRun = runs.find((r) => r.kind === "retention");
    expect(backupRun?.status).toBe("done");
    expect(backupRun?.trigger).toBe("scheduled");
    expect(backupRun?.storageKey).toMatch(new RegExp(`^${BACKUP_PREFIX}.*\\.rbk$`));
    expect((backupRun?.summary as any).files).toBe(1);
    expect((backupRun?.summary as any).tables).toBeGreaterThan(30);
    expect(retentionRun?.status).toBe("done");
    expect((retentionRun?.summary as any).tenants).toBeGreaterThanOrEqual(1);
    backupRunId = backupRun!.id;
    backupKey = backupRun!.storageKey!;
    // a second tick the same day enqueues nothing new
    await jobs.enqueueJob(handle.db, { type: "maintenance", idempotencyKey: "m2", runAt: now() });
    await runOnce(workerDeps());
    const after = await withRlsBypass(handle.db, (tx) => maintenance.listRuns(tx));
    expect(after.filter((r) => r.kind === "backup")).toHaveLength(1);
  });

  it("the archive restores into an empty database and file store with identical counts and files", async () => {
    const data = (await storage.get(backupKey))!.data;
    const info = await inspectArchive(data, key);
    expect(info.files).toBe(1);
    expect(info.tables.tenants).toBe(2); // platform + backup-co
    // the archive is a snapshot: the retention run that followed it added rows since, so compare against the archive's own counts
    const sourceCounts = info.tables;
    expect(Object.keys(sourceCounts).length).toBeGreaterThan(30);

    const target = await createTestDb({ sessionBypass: true });
    const targetStore = new LocalStorage(await mkdtemp(path.join(tmpdir(), "referly-restore-")), BASE);
    try {
      const result = await restoreArchive(target.db, data, key, targetStore, { files: true });
      expect(result.files).toBe(1);
      expect(result.rows).toBe(Object.values(sourceCounts).reduce((a, b) => a + b, 0));
      expect(await backupSvc.tableCounts(target.db)).toEqual(sourceCounts);
      const restored = await targetStore.get(`tenants/${tenantId}/assets/logo.png`);
      expect(restored?.contentType).toBe("image/png");
      expect(Array.from(restored!.data)).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      // the restored database serves the same API: the owner can log in
      const app2 = createApp({ db: target.db, email, storage: targetStore, log: quiet, config: { baseUrl: BASE, webUrl: "http://web.test", cookieSecure: false, now } });
      const login = await app2.request(BASE + "/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bea@backup.co", password: "supersecret1" }) });
      expect(login.status).toBe(200);
    } finally {
      await target.close();
    }
  });

  it("platform admins see maintenance history and configuration, trigger runs, and download archives; merchants cannot", async () => {
    expect((await call("/admin/maintenance", { token: ownerToken })).status).toBe(403);
    const view = await call("/admin/maintenance", { token: adminToken });
    expect(view.status).toBe(200);
    expect(view.body.runs.map((r: any) => r.kind)).toEqual(expect.arrayContaining(["backup", "retention"]));
    expect(view.body.backups.map((b: any) => b.key)).toContain(backupKey);
    expect(view.body.config.backups).toMatchObject({ enabled: true, everyHours: 24, keepDays: 14, includeFiles: true });
    expect(view.body.config.retention.defaults.clicksDays).toBe(400);

    const dl = await call(`/admin/maintenance/backups/${backupRunId}/download`, { token: adminToken });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(isArchive(new TextEncoder().encode(dl.raw)) || dl.raw.startsWith("RFLYBK")).toBe(true);
    expect((await call(`/admin/maintenance/backups/${backupRunId}/download`, { token: ownerToken })).status).toBe(403);

    const trigger = await call("/admin/maintenance/backup", { method: "POST", token: adminToken });
    expect(trigger.status).toBe(202);
    expect(trigger.body.job.type).toBe("backup_run");
    expect((await call("/admin/maintenance/nonsense", { method: "POST", token: adminToken })).status).toBe(400);
    clock = new Date(clock.getTime() + 60_000);
    await runOnce(workerDeps());
    const runs = (await call("/admin/maintenance", { token: adminToken })).body.runs;
    expect(runs.filter((r: any) => r.kind === "backup" && r.trigger === "manual" && r.status === "done")).toHaveLength(1);
    // metrics expose the backup age
    const metrics = await call("/metrics");
    expect(metrics.raw).toMatch(/referly_backup_age_seconds\{status="done"\} \d+/);
    expect(metrics.raw).toMatch(/referly_backup_size_bytes \d+/);
  });

  it("workspace owners read and change their retention policy within bounds; the preview counts what a prune would remove", async () => {
    const view = await call("/v1/tenant/retention", { token: ownerToken });
    expect(view.status).toBe(200);
    expect(view.body.effective).toEqual(view.body.defaults);
    expect(view.body.eligible.clicksDays).toBe(0);
    const updated = await call("/v1/tenant/retention", { method: "PATCH", token: ownerToken, json: { messageLogsDays: 45 } });
    expect(updated.status).toBe(200);
    expect(updated.body.overrides).toEqual({ messageLogsDays: 45 });
    expect(updated.body.effective.messageLogsDays).toBe(45);
    expect((await call("/v1/tenant/retention", { method: "PATCH", token: ownerToken, json: { messageLogsDays: 1 } })).status).toBe(400);
    expect((await call("/v1/tenant/retention", { method: "PATCH", token: ownerToken, json: { bogus: 1 } })).status).toBe(400);
    expect((await call("/v1/tenant/retention", { token: affiliateToken })).status).toBe(403);
  });

  it("an affiliate can request erasure from the portal; the merchant erases them; the login stops working", async () => {
    const req = await call("/portal/erasure-request", { method: "POST", token: affiliateToken });
    expect(req.status).toBe(202);
    expect(req.body.task.entityType).toBe("erasure_request");
    const tasks = await call("/v1/automation/tasks", { token: ownerToken });
    expect(tasks.body.tasks.some((t: any) => t.id === req.body.task.id)).toBe(true);

    const erase = await call(`/v1/affiliates/${affiliateId}/erase`, { method: "POST", token: ownerToken, json: { reason: "request" } });
    expect(erase.status).toBe(200);
    expect(erase.body.affiliate.name).toBe("Erased affiliate");
    expect(erase.body.affiliate.email).toMatch(/@erased\.invalid$/);
    expect((await call("/portal/me", { token: affiliateToken })).status).toBe(401);
    expect((await call("/v1/auth/login", { method: "POST", json: { email: "pat@partner.io", password: "partnerpass1" } })).status).toBe(401);
    expect((await call("/v1/automation/tasks", { token: ownerToken })).body.tasks.find((t: any) => t.id === req.body.task.id)?.status).toBe("done");
  });

  it("the workspace export is JSON lines of every table without secrets, owner only", async () => {
    const req = await call("/v1/analytics/exports", { method: "POST", token: ownerToken, json: { entity: "workspace" } });
    expect(req.status).toBe(202);
    await runOnce(workerDeps());
    const dl = await call(`/v1/analytics/exports/${req.body.export.id}/download`, { token: ownerToken });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("application/x-ndjson");
    expect(dl.headers.get("content-disposition")).toContain(".jsonl");
    const lines = dl.raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "header", tenantId });
    const tables = new Set(lines.slice(1).map((l) => l.table));
    expect(tables).toContain("tenants");
    expect(tables).toContain("affiliates");
    expect(tables).toContain("users");
    expect(tables).not.toContain("sessions");
    expect(dl.raw).not.toContain("passwordHash");
    expect(dl.raw).not.toContain("keyHash");
    // a marketing user cannot request it
    const member = await call("/v1/tenant/team", { method: "POST", token: ownerToken, json: { name: "Mia", email: "mia@backup.co", role: "marketing", password: "marketing123" } });
    expect(member.status).toBe(201);
    const miaToken = (await call("/v1/auth/login", { method: "POST", json: { email: "mia@backup.co", password: "marketing123" } })).body.token;
    expect((await call("/v1/analytics/exports", { method: "POST", token: miaToken, json: { entity: "workspace" } })).status).toBe(403);
  });

  it("a closed workspace is purged with its files after the grace period; other workspaces are untouched", async () => {
    const other = await call("/v1/auth/signup", { method: "POST", json: { name: "Other Co", slug: "other-co", currency: "USD", owner: { name: "Olu", email: "olu@other.co", password: "supersecret1" } } });
    const otherId = (await call("/v1/tenant", { token: other.body.token })).body.tenant.id;
    await storage.put(`tenants/${otherId}/assets/a.png`, new Uint8Array([1]), "image/png");
    await storage.put(`${PRIVATE_PREFIX}tenants/${otherId}/exports/x.csv`, new Uint8Array([2]), "text/csv");
    const closed = await call(`/admin/tenants/${otherId}`, { method: "PATCH", token: adminToken, json: { status: "closed", reason: "churned" } });
    expect(closed.status).toBe(200);
    expect(closed.body.tenant.closedAt).toBeTruthy();
    expect((await call("/v1/tenant", { token: other.body.token })).status).toBe(403);

    // too early: nothing happens
    await jobs.enqueueJob(handle.db, { type: "retention_prune", payload: { trigger: "manual" }, idempotencyKey: "rp-early", runAt: now() });
    await runOnce(workerDeps());
    expect(await storage.get(`tenants/${otherId}/assets/a.png`)).toBeTruthy();
    // after the grace period the rows and files go
    clock = new Date(clock.getTime() + 31 * 86_400_000);
    await jobs.enqueueJob(handle.db, { type: "retention_prune", payload: { trigger: "manual" }, idempotencyKey: "rp-late", runAt: now() });
    await runOnce(workerDeps());
    // sessions expired with the clock jump; sign in again
    adminToken = (await call("/v1/auth/login", { method: "POST", json: { email: "root@platform.test", password: "rootpass123" } })).body.token;
    ownerToken = (await call("/v1/auth/login", { method: "POST", json: { email: "bea@backup.co", password: "supersecret1" } })).body.token;
    const runs = await withRlsBypass(handle.db, (tx) => maintenance.listRuns(tx, { kind: "purge" }));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    expect((runs[0]!.summary as any).files).toBe(2);
    expect(await storage.get(`tenants/${otherId}/assets/a.png`)).toBeNull();
    expect(await storage.get(`tenants/${tenantId}/assets/logo.png`)).toBeTruthy();
    expect((await call(`/admin/tenants/${otherId}`, { token: adminToken })).status).toBe(404);
    expect((await call("/v1/tenant", { token: ownerToken })).status).toBe(200);
    expect((await call("/v1/auth/login", { method: "POST", json: { email: "olu@other.co", password: "supersecret1" } })).status).toBe(401);
  });
});
