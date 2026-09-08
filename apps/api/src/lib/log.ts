/**
 * Structured logging, dependency-free. One JSON object per line in production (LOG_FORMAT=json)
 * so any log shipper can index it; a readable single line in development (LOG_FORMAT=pretty).
 * Every line carries `ts`, `level`, `event` and whatever fields the caller adds; request-scoped
 * lines carry `requestId` so a user-reported id finds the whole story.
 *
 * Secrets never reach the log: field names that look like credentials are redacted recursively.
 */

export type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT = /^(authorization|cookie|set-cookie|password|newpassword|currentpassword|token|secret|secretkey|authtoken|clientsecret|apikey|api_key|credentials|x-twilio-signature|x-referly-signature)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = REDACT.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

export interface LoggerOptions {
  level?: Level;
  format?: "json" | "pretty";
  /** Where lines go; tests capture them. */
  write?: (line: string) => void;
  /** Fields attached to every line (service, version, instance). */
  base?: Record<string, unknown>;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** A logger that adds fields to every line (request id, job id). */
  child(fields: Record<string, unknown>): Logger;
  readonly level: Level;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? ((process.env.LOG_LEVEL as Level | undefined) ?? (process.env.NODE_ENV === "test" ? "error" : "info"));
  const format = opts.format ?? ((process.env.LOG_FORMAT as "json" | "pretty" | undefined) ?? (process.env.NODE_ENV === "production" ? "json" : "pretty"));
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const threshold = LEVELS[level] ?? LEVELS.info;

  function make(bound: Record<string, unknown>): Logger {
    const emit = (lvl: Level, event: string, fields?: Record<string, unknown>) => {
      if (LEVELS[lvl] < threshold) return;
      const entry = { ts: new Date().toISOString(), level: lvl, event, ...(redact({ ...bound, ...(fields ?? {}) }) as Record<string, unknown>) };
      if (format === "json") {
        write(JSON.stringify(entry));
        return;
      }
      const { ts, level: l, event: e, ...rest } = entry;
      const tail = Object.entries(rest)
        .map(([k, v]) => `${k}=${typeof v === "string" ? (/[\s"=]/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`)
        .join(" ");
      write(`${String(ts).slice(11, 23)} ${String(l).toUpperCase().padEnd(5)} ${String(e)}${tail ? " " + tail : ""}`);
    };
    return {
      level,
      debug: (e, f) => emit("debug", e, f),
      info: (e, f) => emit("info", e, f),
      warn: (e, f) => emit("warn", e, f),
      error: (e, f) => emit("error", e, f),
      child: (fields) => make({ ...bound, ...fields }),
    };
  }
  return make(opts.base ?? {});
}

/** Process-wide default; the app and worker use children of it. */
export const log: Logger = createLogger({ base: { service: process.env.SERVICE_NAME ?? "referly-api" } });
