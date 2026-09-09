import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { backup as backupSvc, maintenance, type Db } from "@referly/core";
import { PRIVATE_PREFIX, type FileStorage, type StoredObject } from "./storage";
import { log as rootLog, type Logger } from "./lib/log";

/**
 * Backup archives. A backup is the core dump (JSON lines, see packages/core backup.ts) plus,
 * optionally, every uploaded file, gzip-compressed and encrypted with AES-256-GCM:
 *
 *   "RFLYBK" 0x01 | iv (12 bytes) | auth tag (16 bytes) | ciphertext of gzip(jsonl)
 *
 * The key is SHA-256 of BACKUP_KEY (or INTEGRATION_SECRET when unset). Anyone holding an
 * archive without the key holds noise; anyone who loses the key loses the backups, so keep it
 * with the other secrets. Archives live under private/backups/ in the file store (local disk
 * or the S3 bucket); rotation keeps every backup for BACKUP_KEEP_DAYS days and then one per
 * week for BACKUP_KEEP_WEEKS weeks.
 */
export const BACKUP_PREFIX = `${PRIVATE_PREFIX}backups/`;
export const BACKUP_EXTENSION = ".rbk";
const MAGIC = Buffer.from("RFLYBK\x01", "latin1");
const BLOB_CHUNK = 192 * 1024;

export interface BackupConfig {
  /** 0 disables scheduled backups; manual and CLI runs still work. */
  everyHours: number;
  keepDays: number;
  keepWeeks: number;
  /** Bundle uploaded files into the archive (default: yes for local storage, no for S3, which should use bucket versioning). */
  includeFiles: boolean;
  key: Buffer;
  /** How long a retention prune may lag behind; the scheduler also runs it once a day. */
  retentionEveryHours: number;
}

export function backupKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env.BACKUP_KEY ?? env.INTEGRATION_SECRET;
  if (!secret) {
    if (env.NODE_ENV === "production") throw new Error("BACKUP_KEY (or INTEGRATION_SECRET) is required in production: it encrypts backups");
    return createHash("sha256").update("dev-insecure-backup-key").digest();
  }
  if (secret.length < 16) throw new Error("BACKUP_KEY must be at least 16 characters");
  return createHash("sha256").update(secret).digest();
}

export function backupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const num = (k: string, fallback: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const storageIsS3 = (env.STORAGE_PROVIDER ?? "local").toLowerCase() === "s3";
  return {
    everyHours: num("BACKUP_EVERY_HOURS", 24),
    keepDays: num("BACKUP_KEEP_DAYS", 14),
    keepWeeks: num("BACKUP_KEEP_WEEKS", 8),
    includeFiles: env.BACKUP_INCLUDE_FILES ? env.BACKUP_INCLUDE_FILES === "true" : !storageIsS3,
    key: backupKeyFromEnv(env),
    retentionEveryHours: num("RETENTION_EVERY_HOURS", 24),
  };
}

// ---------------------------------------------------------------------------
// Archive encoding
// ---------------------------------------------------------------------------

/** gzip + encrypt a stream of JSON lines. The whole compressed archive is assembled in memory. */
export async function encodeArchive(lines: AsyncIterable<unknown>, key: Buffer): Promise<Uint8Array> {
  const gzip = createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  gzip.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  for await (const line of lines) {
    if (!gzip.write(JSON.stringify(line) + "\n")) await new Promise<void>((r) => gzip.once("drain", r));
  }
  gzip.end();
  await finished;
  const plain = Buffer.concat(chunks);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function isArchive(data: Uint8Array): boolean {
  return data.byteLength > MAGIC.length + 28 && Buffer.from(data.subarray(0, MAGIC.length)).equals(MAGIC);
}

/** Decrypt + gunzip + split into lines. Throws on a wrong key or a tampered archive (GCM tag). */
export async function* decodeArchive(data: Uint8Array, key: Buffer): AsyncGenerator<backupSvc.BackupLine> {
  if (!isArchive(data)) throw new Error("not a Referly backup archive");
  const buf = Buffer.from(data);
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const ciphertext = buf.subarray(MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("backup cannot be decrypted: wrong BACKUP_KEY or corrupted archive");
  }
  const gunzip = createGunzip();
  const out: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gunzip.on("data", (c: Buffer) => out.push(c));
    gunzip.on("end", resolve);
    gunzip.on("error", reject);
  });
  gunzip.end(plain);
  await done;
  const text = Buffer.concat(out).toString("utf8");
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) break;
    const line = text.slice(start, nl);
    start = nl + 1;
    if (line) yield JSON.parse(line) as backupSvc.BackupLine;
  }
}

// ---------------------------------------------------------------------------
// Producing a backup
// ---------------------------------------------------------------------------

async function* withFiles(lines: AsyncIterable<backupSvc.BackupLine>, storage: FileStorage, include: boolean): AsyncGenerator<backupSvc.BackupLine> {
  let footer: backupSvc.BackupLine | null = null;
  for await (const line of lines) {
    if (line.t === "footer") {
      footer = line;
      continue;
    }
    yield line;
  }
  if (include && storage.list) {
    for (const obj of await storage.list("")) {
      if (obj.key.startsWith(BACKUP_PREFIX)) continue;
      const file = await storage.get(obj.key);
      if (!file) continue;
      yield { t: "file", key: obj.key, contentType: file.contentType, size: file.data.byteLength };
      for (let i = 0; i < file.data.byteLength; i += BLOB_CHUNK) yield { t: "blob", data: Buffer.from(file.data.subarray(i, i + BLOB_CHUNK)).toString("base64") };
      yield { t: "fileend", key: obj.key };
    }
  }
  if (footer) yield footer;
}

export function backupKeyFor(at: Date): string {
  return `${BACKUP_PREFIX}${at.toISOString().replace(/[:.]/g, "-")}${BACKUP_EXTENSION}`;
}

export function backupTimestamp(key: string): Date | null {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(key);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface BackupSummary {
  tables: number;
  rows: number;
  files: number;
  fileBytes: number;
  deleted: string[];
}

/**
 * Dump, archive, upload, rotate, and record it all as a maintenance run. Any failure is
 * recorded on the run and rethrown so the job retries and the error reporter sees it.
 */
export async function runBackup(deps: { db: Db; storage: FileStorage; config: BackupConfig; trigger: maintenance.MaintenanceTrigger; now?: () => Date; log?: Logger }): Promise<{ run: Awaited<ReturnType<typeof maintenance.finishRun>>; key: string }> {
  const now = deps.now ?? (() => new Date());
  const log = (deps.log ?? rootLog).child({ component: "backup" });
  const run = await maintenance.startRun(deps.db, "backup", deps.trigger, now());
  const summary: BackupSummary = { tables: 0, rows: 0, files: 0, fileBytes: 0, deleted: [] };
  try {
    const counted = async function* (): AsyncGenerator<backupSvc.BackupLine> {
      for await (const line of withFiles(backupSvc.dumpDatabase(deps.db, { now }), deps.storage, deps.config.includeFiles)) {
        if (line.t === "end") summary.tables++, (summary.rows += line.count);
        if (line.t === "file") summary.files++, (summary.fileBytes += line.size);
        yield line;
      }
    };
    const archive = await encodeArchive(counted(), deps.config.key);
    const key = backupKeyFor(now());
    await deps.storage.put(key, archive, "application/octet-stream", { private: true });
    summary.deleted = await rotateBackups(deps.storage, deps.config, now());
    const finished = await maintenance.finishRun(deps.db, run.id, { storageKey: key, sizeBytes: archive.byteLength, summary: { ...summary } }, now());
    log.info("backup_done", { key, sizeBytes: archive.byteLength, ...summary, deleted: summary.deleted.length });
    return { run: finished, key };
  } catch (err) {
    await maintenance.failRun(deps.db, run.id, err, { ...summary }, now());
    throw err;
  }
}

/** Keep everything younger than keepDays; older, keep the newest per ISO week for keepWeeks; delete the rest. Returns deleted keys. */
export async function rotateBackups(storage: FileStorage, config: Pick<BackupConfig, "keepDays" | "keepWeeks">, now: Date): Promise<string[]> {
  if (!storage.list || !storage.delete) return [];
  const objects = (await storage.list(BACKUP_PREFIX)).filter((o) => o.key.endsWith(BACKUP_EXTENSION));
  const dated = objects.map((o) => ({ key: o.key, at: backupTimestamp(o.key) ?? o.lastModified ?? now })).sort((a, b) => b.at.getTime() - a.at.getTime());
  const dailyCutoff = now.getTime() - config.keepDays * 86_400_000;
  const weeklyCutoff = dailyCutoff - config.keepWeeks * 7 * 86_400_000;
  const keptWeeks = new Set<string>();
  const remove: string[] = [];
  for (const b of dated) {
    const t = b.at.getTime();
    if (t >= dailyCutoff) continue;
    if (t < weeklyCutoff) {
      remove.push(b.key);
      continue;
    }
    const week = isoWeek(b.at);
    if (keptWeeks.has(week)) remove.push(b.key);
    else keptWeeks.add(week);
  }
  for (const key of remove) await storage.delete(key);
  return remove;
}

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function listBackups(storage: FileStorage): Promise<StoredObject[]> {
  if (!storage.list) return [];
  return (await storage.list(BACKUP_PREFIX)).filter((o) => o.key.endsWith(BACKUP_EXTENSION)).sort((a, b) => b.key.localeCompare(a.key));
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** Also write the archive's files back into the store. */
  files?: boolean;
  onTable?: (name: string, count: number) => void;
}

/** Split the archive into the database part (fed to core) and the files part (written to storage). */
export async function restoreArchive(db: Db, data: Uint8Array, key: Buffer, storage: FileStorage | null, opts: RestoreOptions = {}): Promise<backupSvc.RestoreResult & { files: number; fileBytes: number }> {
  const pendingFiles: { key: string; contentType: string; chunks: Buffer[] }[] = [];
  let current: { key: string; contentType: string; chunks: Buffer[] } | null = null;
  async function* dbLines(): AsyncGenerator<backupSvc.BackupLine> {
    for await (const line of decodeArchive(data, key)) {
      if (line.t === "file") current = { key: line.key, contentType: line.contentType, chunks: [] };
      else if (line.t === "blob") current?.chunks.push(Buffer.from(line.data, "base64"));
      else if (line.t === "fileend") {
        if (current) pendingFiles.push(current);
        current = null;
      } else yield line;
    }
  }
  const result = await backupSvc.restoreDatabase(db, dbLines(), { onTable: opts.onTable });
  let files = 0;
  let fileBytes = 0;
  if (opts.files && storage) {
    for (const f of pendingFiles) {
      const body = Buffer.concat(f.chunks);
      await storage.put(f.key, body, f.contentType, { private: f.key.startsWith(PRIVATE_PREFIX) });
      files++;
      fileBytes += body.byteLength;
    }
  }
  return { ...result, files, fileBytes };
}

/** Read an archive's header and per-table counts without touching a database. */
export async function inspectArchive(data: Uint8Array, key: Buffer): Promise<{ at: string; format: number; migrations: number; tables: Record<string, number>; files: number; fileBytes: number }> {
  const out = { at: "", format: 0, migrations: 0, tables: {} as Record<string, number>, files: 0, fileBytes: 0 };
  for await (const line of decodeArchive(data, key)) {
    if (line.t === "header") {
      out.at = line.at;
      out.format = line.format;
      out.migrations = line.migrations.length;
    } else if (line.t === "end") out.tables[line.table] = line.count;
    else if (line.t === "file") {
      out.files++;
      out.fileBytes += line.size;
    }
  }
  return out;
}
