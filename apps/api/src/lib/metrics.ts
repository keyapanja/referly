/**
 * In-process metrics rendered in the Prometheus text format at /metrics. Counters and histograms
 * are per process (one API instance = one series set; label by instance in your scraper). Queue
 * depth, lag and dead-letter counts are read from the database at scrape time, so they are true
 * across every instance. No dependency, so the format stays under our control.
 */

type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
}

class Counter {
  readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    const cur = this.values.get(k);
    if (cur) cur.value += by;
    else this.values.set(k, { labels, value: by });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}{${key(labels)}} ${value}`);
    return lines.join("\n");
  }
}

class Histogram {
  readonly series = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
  ) {}
  observe(labels: Labels, value: number) {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    for (let i = 0; i < this.bounds.length; i++) if (value <= this.bounds[i]!) s.buckets[i]!++;
    s.sum += value;
    s.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, buckets, sum, count } of this.series.values()) {
      const base = key(labels);
      for (let i = 0; i < this.bounds.length; i++) lines.push(`${this.name}_bucket{${base}${base ? "," : ""}le="${this.bounds[i]}"} ${buckets[i]}`);
      lines.push(`${this.name}_bucket{${base}${base ? "," : ""}le="+Inf"} ${count}`);
      lines.push(`${this.name}_sum{${base}} ${sum}`);
      lines.push(`${this.name}_count{${base}} ${count}`);
    }
    return lines.join("\n");
  }
}

export const httpRequests = new Counter("referly_http_requests_total", "HTTP requests by method, route and status class");
export const httpDuration = new Histogram("referly_http_request_duration_seconds", "HTTP request latency", [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
export const jobsProcessed = new Counter("referly_jobs_processed_total", "Background jobs finished by type and outcome (ok, retry, dead)");
export const jobDuration = new Histogram("referly_job_duration_seconds", "Background job handler time by type", [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]);
export const errorsReported = new Counter("referly_errors_total", "Unhandled errors by origin (http, worker)");

/** Gauges read at scrape time (queue state, worker heartbeat). */
export interface GaugeSnapshot {
  name: string;
  help: string;
  values: { labels?: Labels; value: number }[];
}

const startedAt = Date.now();

/** Collapse dynamic path segments so the route label has bounded cardinality. */
export function routeLabel(path: string): string {
  return (
    path
      .replace(/\/(ten|usr|aff|prg|off|cnv|com|pay|ast|cmp|rul|tsk|grp|tier|dsp|whs|whd|exp|int|msg|key|clk|lnk|inv|sess)_[A-Za-z0-9_-]+/g, "/:id")
      .replace(/\/(r|join|invite)\/[^/]+/, "/$1/:token")
      .replace(/\/hooks\/twilio\/[^/]+/, "/hooks/twilio/:tenantId")
      .replace(/\/files\/.+$/, "/files/*")
      .replace(/\/[A-Za-z0-9_-]{16,}/g, "/:id") || "/"
  );
}

export function renderMetrics(gauges: GaugeSnapshot[]): string {
  const blocks = [
    `# HELP referly_process_uptime_seconds Seconds since the process started\n# TYPE referly_process_uptime_seconds gauge\nreferly_process_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
    `# HELP referly_process_resident_memory_bytes Resident set size\n# TYPE referly_process_resident_memory_bytes gauge\nreferly_process_resident_memory_bytes ${process.memoryUsage().rss}`,
    httpRequests.render(),
    httpDuration.render(),
    jobsProcessed.render(),
    jobDuration.render(),
    errorsReported.render(),
    ...gauges.map((g) => [`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, ...g.values.map((v) => `${g.name}${v.labels ? `{${key(v.labels)}}` : ""} ${v.value}`)].join("\n")),
  ];
  return blocks.join("\n\n") + "\n";
}

/** Test hook. */
export function resetMetrics() {
  for (const c of [httpRequests, jobsProcessed, errorsReported]) c.values.clear();
  for (const h of [httpDuration, jobDuration]) h.series.clear();
}
