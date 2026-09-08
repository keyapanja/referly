import { serve } from "@hono/node-server";
import { createDb, platform, withRlsBypass, assertIntegrationSecret } from "@referly/core";
import { createApp } from "./app";
import { startWorker } from "./worker";
import { createEmailProvider } from "./email";
import { createFileStorage } from "./storage";
import { createTextDeps } from "./text";

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
const app = createApp({ db, email, storage, text, config: { baseUrl, webUrl, cookieSecure: baseUrl.startsWith("https"), supportEmail: process.env.PLATFORM_SUPPORT_EMAIL, trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) || 0 } });

// Idempotent platform-admin bootstrap (PRD s15 platform_admin role).
if (process.env.PLATFORM_ADMIN_EMAIL && process.env.PLATFORM_ADMIN_PASSWORD) {
  const admin = await withRlsBypass(db, (tx) => platform.ensurePlatformAdmin(tx, { email: process.env.PLATFORM_ADMIN_EMAIL!, password: process.env.PLATFORM_ADMIN_PASSWORD!, name: process.env.PLATFORM_ADMIN_NAME }));
  console.log(`platform admin ready: ${admin.email}`);
}
const worker = startWorker({ db, email, storage, webUrl, baseUrl, text });
// webhook deliveries use the global fetch

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port} (db: ${process.env.DATABASE_URL ? "postgres" : "pglite"})`);
});

async function shutdown() {
  worker.stop();
  server.close();
  await close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
