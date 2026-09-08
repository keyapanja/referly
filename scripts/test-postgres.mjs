#!/usr/bin/env node
/**
 * Runs the whole test suite against a real Postgres server.
 *
 *   npm run test:postgres                 # starts an embedded Postgres, runs `npm test`, stops it
 *   TEST_DATABASE_URL=postgres://… npm run test:postgres   # uses that server instead
 *
 * Each test file gets a throwaway database on the server (created, migrated from zero, dropped),
 * so this exercises the migrations, row-level security and the pooled-connection role switch
 * exactly as production does. The embedded server comes from the `embedded-postgres` package
 * (real Postgres binaries; on Windows they need the Microsoft Visual C++ runtime installed).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const extraArgs = process.argv.slice(2);
let stop = async () => {};
let url = process.env.TEST_DATABASE_URL;

if (!url) {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = mkdtempSync(path.join(tmpdir(), "referly-pg-"));
  const port = 54300 + Math.floor(Math.random() * 200);
  const server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  console.log(`starting embedded Postgres on port ${port}…`);
  await server.initialise();
  await server.start();
  url = `postgres://postgres:postgres@localhost:${port}/postgres`;
  stop = async () => {
    await server.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
}

console.log(`running tests against ${url.replace(/:[^:@/]+@/, ":***@")}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["test", ...extraArgs], { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, TEST_DATABASE_URL: url, NODE_ENV: "test" } });
const code = await new Promise((resolve) => child.on("exit", resolve));
await stop();
process.exit(code ?? 1);
