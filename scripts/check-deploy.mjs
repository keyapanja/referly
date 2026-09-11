#!/usr/bin/env node
/**
 * Post-deploy smoke check. Run from any machine with Node 20+ against the live addresses:
 *
 *   node scripts/check-deploy.mjs https://app.example.com https://api.example.com
 *
 * Catches the configuration mistakes that make a deploy look healthy while nothing works: the
 * web app built without NEXT_PUBLIC_API_URL (browsers call localhost), app and API on unrelated
 * domains (the session cookie is never sent), WEB_URL wrong on the API (CORS refuses the app),
 * BASE_URL not https, no TLS, the API not in production mode, and the database or worker down.
 * Reads nothing private, changes nothing, exits non-zero when a check fails.
 */
const [webArg, apiArg] = process.argv.slice(2);
if (!webArg || !apiArg) {
  console.error("usage: node scripts/check-deploy.mjs <web app url> <api url>");
  process.exit(2);
}
const web = new URL(webArg).origin;
const api = new URL(apiArg).origin;

let failed = 0;
let warned = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const warn = (msg, fix) => {
  warned++;
  console.log(`  WARN  ${msg}${fix ? `\n        ${fix}` : ""}`);
};
const fail = (msg, fix) => {
  failed++;
  console.log(`  FAIL  ${msg}${fix ? `\n        ${fix}` : ""}`);
};

const unreachable = (error) => ({ status: 0, error, headers: new Headers(), text: async () => "", json: async () => null });
async function get(url, init = {}) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(15_000), ...init });
  } catch (err) {
    return unreachable(err?.cause?.code ?? err?.message ?? String(err));
  }
}
const statusOf = (res) => (res.status ? String(res.status) : `no answer (${res.error})`);

/** Registrable domain, near enough: the last two labels, or three under a two-level suffix such as co.uk. */
function site(host) {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  return /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

console.log(`\nReferly deploy check\n  web app  ${web}\n  api      ${api}\n`);

// ---------------------------------------------------------------------------
console.log("Addresses");
for (const [name, origin] of [
  ["web app", web],
  ["api", api],
]) {
  if (origin.startsWith("https://")) pass(`${name} is served over HTTPS`);
  else fail(`${name} is not HTTPS (${origin})`, "Enter the domain in Coolify with https:// so a certificate is issued. Sessions are only marked Secure over HTTPS.");
}
const webHost = new URL(web).hostname;
const apiHost = new URL(api).hostname;
if (site(webHost) === site(apiHost)) pass(`app and API share ${site(webHost)}, so the browser sends the session cookie`);
else fail(`app (${webHost}) and API (${apiHost}) are on different domains`, "Use two subdomains of one domain, such as app.example.com and api.example.com. Sign-in cannot work otherwise.");

// ---------------------------------------------------------------------------
console.log("\nAPI");
const health = await get(`${api}/health`);
if (health.status === 200) pass("/health answers and the database is reachable");
else fail(`/health: ${statusOf(health)}`, health.status ? "Read the API logs in Coolify." : "Nothing answers here: check the DNS record, the domain on the Coolify application, and that the container is running.");

if (health.status) await checkApi();
else console.log("        The remaining API checks need the API to answer, so they were skipped.");

async function checkApi() {
  const ready = await get(`${api}/health/ready`);
  const readyBody = await ready.json().catch(() => null);
  if (ready.status === 200 && readyBody?.ok) pass(`/health/ready: database ${readyBody.db}, ${readyBody.migrations} migrations applied${readyBody.worker ? `, worker ${readyBody.worker}` : ""}`);
  else fail(`/health/ready: ${statusOf(ready)}${readyBody ? ` ${JSON.stringify(readyBody)}` : ""}`, "db down: check DATABASE_URL. worker stale or not started: read the API logs.");

  if (api.startsWith("https://")) {
    if (health.headers.get("strict-transport-security")) pass("the API knows it is behind HTTPS (HSTS is sent)");
    else fail("the API does not send HSTS, so BASE_URL does not start with https://", `Set BASE_URL=${api} on the API. Tracking, join and invite links are built from it, and session cookies are only Secure with it.`);
  }

  const metrics = await get(`${api}/metrics`);
  if (metrics.status === 401) pass("/metrics is protected by METRICS_TOKEN");
  else if (metrics.status === 404) warn("production mode, but METRICS_TOKEN is not set, so metrics are off", "Set METRICS_TOKEN if you want Prometheus metrics.");
  else if (metrics.status === 200) fail("/metrics is public, so NODE_ENV is not production", "Set NODE_ENV=production on the API. Without it the start-up checks for INTEGRATION_SECRET and a real email provider are skipped.");
  else warn(`/metrics: ${statusOf(metrics)}`);

  const anonymous = await get(`${api}/v1/tenant/me`);
  if (anonymous.status === 401) pass("protected routes refuse anonymous requests");
  else fail(`/v1/tenant/me without a session: ${statusOf(anonymous)}`, "Expected 401. A 5xx means requests are failing: read the API logs.");

  const preflight = await get(`${api}/v1/tenant/me`, { method: "OPTIONS", headers: { origin: web, "access-control-request-method": "GET" } });
  const allowOrigin = preflight.headers.get("access-control-allow-origin");
  const allowCreds = preflight.headers.get("access-control-allow-credentials");
  if (allowOrigin === web && allowCreds === "true") pass(`CORS lets ${web} call the API with its session`);
  else fail(`CORS allows ${allowOrigin ?? "no origin"}${allowCreds === "true" ? "" : ", without credentials"}`, `Set WEB_URL=${web} on the API and redeploy it.`);

  const snippet = await get(`${api}/referly.js`);
  if (snippet.status === 200 && (snippet.headers.get("content-type") ?? "").includes("javascript")) pass("the website tracking snippet is served at /referly.js");
  else fail(`/referly.js: ${statusOf(snippet)}`);
}

// ---------------------------------------------------------------------------
console.log("\nWeb app");
const login = await get(`${web}/login`);
const html = login.status === 200 ? await login.text() : "";
if (login.status === 200) pass("/login loads");
else fail(`/login: ${statusOf(login)}`, "Check the web application's domain and logs in Coolify.");

if (html) {
  const scripts = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+?\.js)/g)].map((m) => m[1]))].slice(0, 80);
  let callsApi = false;
  let callsLocalhost = false;
  for (const path of scripts) {
    const res = await get(web + path);
    if (res.status !== 200) continue;
    const body = await res.text();
    if (body.includes(api)) callsApi = true;
    if (body.includes("localhost:4000")) callsLocalhost = true;
  }
  const apiIsLocalhost = api.includes("localhost:4000");
  if (!scripts.length) warn("could not find the app's scripts to inspect");
  else if (callsLocalhost && !apiIsLocalhost) fail("the web app was built to call http://localhost:4000", `On the web application in Coolify, set NEXT_PUBLIC_API_URL=${api} with Build Variable ticked, then redeploy. A restart is not enough.`);
  else if (callsApi) pass(`the browser bundle calls ${api}`);
  else warn(`could not confirm the browser bundle calls ${api}`, "If sign-in fails, rebuild the web app with NEXT_PUBLIC_API_URL set as a Build Variable.");
}

// ---------------------------------------------------------------------------
const summary = failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : "All checks passed";
console.log(`\n${summary}${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}.\n`);
process.exit(failed ? 1 : 0);
