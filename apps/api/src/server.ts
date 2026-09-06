import { serve } from "@hono/node-server";
import { createDb } from "@referly/core";
import { createApp } from "./app";
import { startWorker } from "./worker";
import { createEmailProvider } from "./email";
import { createFileStorage } from "./storage";

const port = Number(process.env.PORT ?? 4000);
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const webUrl = process.env.WEB_URL ?? "http://localhost:3000";

const { db, close } = await createDb({ dataDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? ".pglite") });
const email = createEmailProvider();
const storage = createFileStorage(process.env, baseUrl);
const app = createApp({ db, email, storage, config: { baseUrl, webUrl, cookieSecure: baseUrl.startsWith("https") } });
const worker = startWorker({ db, email, webUrl });

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
