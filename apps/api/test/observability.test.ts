import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/lib/log";
import { httpRequests, renderMetrics, resetMetrics, routeLabel } from "../src/lib/metrics";
import { createErrorReporter } from "../src/lib/report";

const quiet = createLogger({ level: "error", write: () => {} });

describe("observability primitives", () => {
  it("logger emits JSON lines with bound fields and redacts credentials", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", format: "json", write: (l) => lines.push(l), base: { service: "t" } }).child({ requestId: "r1" });
    log.debug("hidden");
    log.info("hello", { user: "u", password: "p@ss", nested: { authorization: "Bearer x", ok: 1 }, err: new Error("boom") });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: "info", event: "hello", service: "t", requestId: "r1", user: "u", password: "[redacted]", nested: { authorization: "[redacted]", ok: 1 } });
    expect(entry.err.message).toBe("boom");
    expect(entry.ts).toMatch(/^\d{4}-/);
    expect(redact({ token: "abc", list: [{ secret: "s" }] })).toEqual({ token: "[redacted]", list: [{ secret: "[redacted]" }] });
    const pretty: string[] = [];
    createLogger({ level: "warn", format: "pretty", write: (l) => pretty.push(l) }).warn("slow", { ms: 12, path: "/a b" });
    expect(pretty[0]).toMatch(/WARN\s+slow ms=12 path="\/a b"$/);
  });

  it("route labels bound cardinality and metrics render in the Prometheus text format", () => {
    expect(routeLabel("/v1/affiliates/aff_ULPtnvnN52JM6U5gHzaVG")).toBe("/v1/affiliates/:id");
    expect(routeLabel("/r/abc123xyz9")).toBe("/r/:token");
    expect(routeLabel("/files/tenants/ten_x/assets/abcdef.png")).toBe("/files/*");
    expect(routeLabel("/hooks/twilio/ten_BBNi53G0cTh4DTLJZHiqV/status")).toBe("/hooks/twilio/:tenantId/status");
    resetMetrics();
    httpRequests.inc({ method: "GET", route: "/health", status: "2xx" }, 3);
    const out = renderMetrics([{ name: "referly_jobs_lag_seconds", help: "lag", values: [{ value: 7 }] }]);
    expect(out).toContain("# TYPE referly_http_requests_total counter");
    expect(out).toContain('referly_http_requests_total{method="GET",route="/health",status="2xx"} 3');
    expect(out).toContain("referly_jobs_lag_seconds 7");
    expect(out).toContain("# TYPE referly_http_request_duration_seconds histogram");
  });

  it("error reporter posts a compact summary with the request id and throttles floods", async () => {
    const posts: { url: string; body: any; auth?: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.authorization });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const reporter = createErrorReporter({ url: "https://alerts.example.test/hook", token: "t0k", fetchImpl, maxPerMinute: 2, service: "svc", log: quiet });
    await reporter.report(new Error("db exploded"), { origin: "http", requestId: "req-9", path: "/v1/x", method: "POST", tenantId: "ten_1" });
    await reporter.report(new Error("again"), { origin: "worker", jobId: "job_1", jobType: "export_csv" });
    await reporter.report(new Error("flood"), { origin: "worker" });
    expect(posts).toHaveLength(2);
    expect(reporter.posted).toBe(2);
    expect(posts[0]).toMatchObject({ url: "https://alerts.example.test/hook", auth: "Bearer t0k" });
    expect(posts[0]!.body).toMatchObject({ service: "svc", origin: "http", message: "db exploded", requestId: "req-9", path: "/v1/x", tenantId: "ten_1" });
    expect(posts[0]!.body.text).toContain("request req-9");
    expect(posts[1]!.body).toMatchObject({ origin: "worker", jobId: "job_1", jobType: "export_csv" });
    const silent = createErrorReporter({ url: undefined, fetchImpl, log: quiet });
    await silent.report("string error", { origin: "process" });
    expect(posts).toHaveLength(2);
  });
});
