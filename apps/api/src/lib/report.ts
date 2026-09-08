import { log as rootLog, type Logger } from "./log";
import { errorsReported } from "./metrics";

/**
 * Error reporting. Every unhandled error is logged with its request or job id. When
 * ERROR_REPORT_URL is set, a compact JSON summary is also POSTed there (a Slack incoming webhook,
 * Better Stack, PagerDuty Events, your own collector) with an optional bearer token. Posts are
 * throttled so an incident cannot turn into a flood of its own.
 */
export interface ErrorReport {
  origin: "http" | "worker" | "process";
  message: string;
  name?: string;
  stack?: string;
  requestId?: string;
  jobId?: string;
  jobType?: string;
  tenantId?: string;
  path?: string;
  method?: string;
}

export interface ReporterOptions {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** Max posts per minute; the rest are only logged. */
  maxPerMinute?: number;
  service?: string;
  log?: Logger;
}

export interface ErrorReporter {
  report(err: unknown, context: Omit<ErrorReport, "message" | "name" | "stack">): Promise<void>;
  /** For tests. */
  readonly posted: number;
}

export function createErrorReporter(opts: ReporterOptions = {}): ErrorReporter {
  const url = opts.url ?? process.env.ERROR_REPORT_URL;
  const token = opts.token ?? process.env.ERROR_REPORT_TOKEN;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPerMinute = opts.maxPerMinute ?? 30;
  const service = opts.service ?? process.env.SERVICE_NAME ?? "referly-api";
  const log = opts.log ?? rootLog;
  let windowStart = 0;
  let inWindow = 0;
  let posted = 0;

  return {
    get posted() {
      return posted;
    },
    async report(err, context) {
      const e = err instanceof Error ? err : new Error(String(err));
      const report: ErrorReport = { ...context, message: e.message, name: e.name, stack: e.stack };
      errorsReported.inc({ origin: context.origin });
      log.error("unhandled_error", { ...context, err: e });
      if (!url) return;
      const now = Date.now();
      if (now - windowStart > 60_000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > maxPerMinute) return;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ service, environment: process.env.NODE_ENV ?? "development", at: new Date(now).toISOString(), ...report, text: `[${service}] ${context.origin} error: ${e.message}${context.requestId ? ` (request ${context.requestId})` : ""}${context.jobId ? ` (job ${context.jobId})` : ""}` }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) posted++;
        else log.warn("error_report_rejected", { status: res.status });
      } catch (postErr) {
        log.warn("error_report_failed", { err: postErr });
      }
    },
  };
}
