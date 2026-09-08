import { serve } from "@hono/node-server";
import { createDb, platform, withRlsBypass, assertIntegrationSecret } from "@referly/core";
import { createApp } from "./app";
import { startWorker } from "./worker";
import { createEmailProvider } from "./email";
import { createFileStorage } from "./storage";
import { createTextDeps } from "./text";
import { log } from "./lib/log";
import { createErrorReporter } from "./lib/report";

// Local development: load apps/api/.env if present (never committed). Hosted setups use real env vars.
try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file */
}

assertIntegrationSecret();
const port = Number(process.env.PORT ?? 4000);
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const webUrl = process.env.WEB_URL ?? "http://localhost:3000";

const { db, close } = await createDb({ dataDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? ".pglite") });
const email = createEmailProvider();
const storage = createFileStorage(process.env, baseUrl);
const text = createTextDeps();
const reporter = createErrorReporter();
let workerHandle: ReturnType<typeof startWorker> | null = null;
const app = createApp({
  db,
  email,
  storage,
  text,
  reporter,
  log,
  config: {
    baseUrl,
    webUrl,
    cookieSecure: baseUrl.startsWith("https"),
    supportEmail: process.env.PLATFORM_SUPPORT_EMAIL,
    trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) || 0,
    metricsToken: process.env.METRICS_TOKEN,
    readiness: { workerHeartbeat: () => workerHandle?.lastTickAt() ?? null },
  },
});

// Anything that escapes a request or a job still gets logged and reported before the process decides what to do.
process.on("unhandledRejection", (reason) => void reporter.report(reason, { origin: "process" }));
process.on("uncaughtException", (err) => {
  void reporter.report(err, { origin: "process" }).finally(() => process.exit(1));
});

// Idempotent platform-admin bootstrap (PRD s15 platform_admin role).
if (process.env.PLATFORM_ADMIN_EMAIL && process.env.PLATFORM_ADMIN_PASSWORD) {
  const admin = await withRlsBypass(db, (tx) => platform.ensurePlatformAdmin(tx, { email: process.env.PLATFORM_ADMIN_EMAIL!, password: process.env.PLATFORM_ADMIN_PASSWORD!, name: process.env.PLATFORM_ADMIN_NAME }));
  log.info("platform_admin_ready", { email: admin.email });
}
const worker = startWorker({ db, email, storage, webUrl, baseUrl, text, reporter, log });
workerHandle = worker;
// webhook deliveries use the global fetch

const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info("api_listening", { port: info.port, db: process.env.DATABASE_URL ? "postgres" : "pglite", baseUrl, webUrl, node: process.version });
});

async function shutdown() {
  worker.stop();
  server.close();
  await close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
