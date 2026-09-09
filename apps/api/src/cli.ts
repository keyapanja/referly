import { readFile, writeFile } from "node:fs/promises";
import { createDb, assertIntegrationSecret, backup as backupSvc, maintenance, withRlsBypass } from "@referly/core";
import { createFileStorage } from "./storage";
import { backupConfigFromEnv, inspectArchive, listBackups, restoreArchive, runBackup, BACKUP_PREFIX } from "./backup";
import { log } from "./lib/log";

/**
 * Operator CLI. Same environment as the server (DATABASE_URL, STORAGE_PROVIDER, BACKUP_KEY).
 *
 *   npm run backup                       take a backup now (prints the storage key)
 *   npm run backup -- list               list archives in the store
 *   npm run backup -- verify <key|file>  decrypt and summarise an archive without touching a database
 *   npm run backup -- save <key> <file>  copy an archive out of the store to a local file
 *   npm run restore -- <key|file> --yes [--files]
 *                                        replace the database at DATABASE_URL with the archive's contents
 *
 * Restore is destructive and refuses to run without --yes. Point DATABASE_URL at the database
 * you mean to overwrite; migrations run first so an older archive lands in the current schema.
 */
try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file */
}

const [command = "backup", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));

function usage(): never {
  console.error("usage: cli backup | backup list | backup verify <key|file> | backup save <key> <file> | restore <key|file> --yes [--files]");
  process.exit(2);
}

async function readArchive(ref: string, storage: ReturnType<typeof createFileStorage>): Promise<Uint8Array> {
  if (ref.startsWith(BACKUP_PREFIX)) {
    const obj = await storage.get(ref);
    if (!obj) throw new Error(`no such backup in the file store: ${ref}`);
    return obj.data;
  }
  return readFile(ref);
}

async function main() {
  assertIntegrationSecret();
  const config = backupConfigFromEnv();
  const storage = createFileStorage(process.env, process.env.BASE_URL ?? "http://localhost:4000");

  if (command === "backup" && args[0] === "list") {
    for (const b of await listBackups(storage)) console.log(`${b.key}\t${b.sizeBytes} bytes${b.lastModified ? `\t${b.lastModified.toISOString()}` : ""}`);
    return;
  }
  if (command === "backup" && args[0] === "verify") {
    if (!args[1]) usage();
    const info = await inspectArchive(await readArchive(args[1], storage), config.key);
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (command === "backup" && args[0] === "save") {
    if (!args[1] || !args[2]) usage();
    const data = await readArchive(args[1], storage);
    await writeFile(args[2], data);
    console.log(`wrote ${data.byteLength} bytes to ${args[2]}`);
    return;
  }

  const { db, close } = await createDb({ dataDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? ".pglite") });
  try {
    if (command === "backup") {
      const { run, key } = await runBackup({ db, storage, config, trigger: "cli", log });
      console.log(JSON.stringify({ key, sizeBytes: run.sizeBytes, ...run.summary }, null, 2));
      return;
    }
    if (command === "restore") {
      const ref = args[0];
      if (!ref) usage();
      if (!flags.has("--yes")) {
        console.error(`refusing to overwrite the database at ${process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).pathname : "the embedded PGlite directory"} without --yes`);
        process.exit(2);
      }
      const data = await readArchive(ref, storage);
      const info = await inspectArchive(data, config.key);
      console.error(`restoring archive from ${info.at}: ${Object.keys(info.tables).length} tables, ${Object.values(info.tables).reduce((a, b) => a + b, 0)} rows, ${info.files} files`);
      // The restore truncates maintenance_runs too, so its own record is written afterwards.
      const startedAt = new Date();
      try {
        const result = await restoreArchive(db, data, config.key, storage, { files: flags.has("--files"), onTable: (name, count) => console.error(`  ${name}: ${count}`) });
        const counts = await withRlsBypass(db, (tx) => backupSvc.tableCounts(tx));
        const mismatched = Object.entries(info.tables).filter(([t, n]) => counts[t] !== undefined && counts[t] !== n);
        await withRlsBypass(db, async (tx) => {
          const run = await maintenance.startRun(tx, "restore", "cli", startedAt);
          await maintenance.finishRun(tx, run.id, { storageKey: ref.startsWith(BACKUP_PREFIX) ? ref : null, sizeBytes: data.byteLength, summary: { ...result, migrations: result.migrations.length, archiveAt: info.at, mismatched } });
        });
        console.log(JSON.stringify({ ...result, migrations: result.migrations.length, mismatched }, null, 2));
        if (mismatched.length) process.exitCode = 1;
      } catch (err) {
        await withRlsBypass(db, async (tx) => {
          const run = await maintenance.startRun(tx, "restore", "cli", startedAt);
          await maintenance.failRun(tx, run.id, err);
        }).catch(() => {});
        throw err;
      }
      return;
    }
    usage();
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
