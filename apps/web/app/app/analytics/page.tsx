"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { EXPORT_FINISHED, downloadExport, watchExport, type ExportFile } from "@/lib/exports";
import { useAction, useApi } from "@/lib/hooks";
import { date, dateTime, money, percent } from "@/lib/format";
import { Alert, Badge, Loading, PageHeader, Table } from "@/components/ui";
import { ChartCard, DeltaStat, Legend, SeriesChart, compact, type Point } from "@/components/charts";

const PRESETS: { key: string; label: string; days: number }[] = [
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "365", label: "Last 12 months", days: 365 },
];

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

interface ExportDataset {
  id: string;
  label: string;
  description: string;
  format: "csv" | "json";
  period: "required" | "optional" | "none";
  datedBy: string | null;
  ownerOnly: boolean;
}

const FILE_STATUS: Record<string, string> = { queued: "waiting", running: "preparing", done: "ready", failed: "failed" };

/** Bring something into view, gently unless the person has asked their system for less motion. */
function reveal(el: Element | null) {
  if (!el) return;
  const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
}

export default function AnalyticsPage() {
  const [preset, setPreset] = useState("30");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [granularity, setGranularity] = useState<"auto" | "day" | "week" | "month">("auto");
  const range = useMemo(() => {
    if (preset === "custom" && custom.from && custom.to) return { from: new Date(`${custom.from}T00:00:00Z`).toISOString(), to: new Date(`${custom.to}T23:59:59Z`).toISOString() };
    const days = PRESETS.find((p) => p.key === preset)?.days ?? 30;
    const to = new Date();
    return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, custom.from, custom.to]);
  const q = `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const gq = granularity === "auto" ? "" : `&granularity=${granularity}`;

  const { data: me } = useApi<any>("/v1/tenant/me");
  const { data: cmp, error } = useApi<any>(`/v1/analytics/compare${q}`);
  const { data: series } = useApi<any>(`/v1/analytics/timeseries${q}${gq}&compare=1`);
  const { data: funnel } = useApi<any>(`/v1/analytics/funnel${q}`);
  const { data: byAffiliate } = useApi<any>(`/v1/analytics/affiliates${q}`);
  const { data: byOffer } = useApi<any>(`/v1/analytics/offers${q}`);
  const { data: byProgram } = useApi<any>(`/v1/analytics/programs${q}`);
  const { data: bySource } = useApi<any>(`/v1/analytics/sources${q}`);
  const { data: byGroup } = useApi<any>(`/v1/analytics/groups${q}`);
  const { data: byCampaign } = useApi<any>("/v1/analytics/campaigns");
  const cur = me?.tenant?.currency ?? "USD";
  const { data: exportsData, reload: reloadExports } = useApi<any>("/v1/analytics/exports");
  const { busy, error: exportError, run, setError: setExportError } = useAction();
  const [exportEntity, setExportEntity] = useState("performance");
  const [exportScope, setExportScope] = useState<"period" | "all">("period");
  const [readyId, setReadyId] = useState<string | null>(null);
  const exportCard = useRef<HTMLDivElement>(null);
  const files: ExportFile[] = exportsData?.exports ?? [];
  const pending = files.some((e) => e.status === "queued" || e.status === "running");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(reloadExports, 2500);
    return () => clearInterval(t);
  }, [pending, reloadExports]);
  // The watcher in the app shell says when a file this person asked for has finished: refresh the list and point at it.
  useEffect(() => {
    const on = (e: Event) => {
      setReadyId((e as CustomEvent<ExportFile>).detail?.id ?? null);
      reloadExports();
    };
    window.addEventListener(EXPORT_FINISHED, on);
    return () => window.removeEventListener(EXPORT_FINISHED, on);
  }, [reloadExports]);
  useEffect(() => {
    if (!readyId || !files.some((f) => f.id === readyId && (f.status === "done" || f.status === "failed"))) return;
    reveal(document.getElementById(`export-${readyId}`));
    const t = setTimeout(() => setReadyId(null), 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyId, exportsData]);
  // Arriving from a toast on another page ("Show my files"): the section exists only once the page has loaded.
  const loaded = !!cmp;
  useEffect(() => {
    if (loaded && window.location.hash === "#exports") reveal(exportCard.current);
  }, [loaded]);

  const datasets: ExportDataset[] = exportsData?.datasets ?? [];
  const dataset = datasets.find((x) => x.id === exportEntity) ?? datasets[0];
  const isOwner = me?.user?.role === "owner";
  const wholePeriod = dataset?.period === "required" ? "period" : dataset?.period === "none" ? "all" : exportScope;

  async function prepareExport() {
    if (!dataset) return;
    const json = wholePeriod === "period" ? { entity: dataset.id, from: range.from, to: range.to } : { entity: dataset.id };
    const res = await run(() => api<{ export: ExportFile }>("/v1/analytics/exports", { method: "POST", json }));
    if (!res) return;
    watchExport(res.export.id);
    reloadExports();
  }
  async function download(file: ExportFile) {
    setExportError(null);
    if (!(await downloadExport(file))) setExportError("That file could not be downloaded. It may have expired: prepare it again.");
  }

  if (!cmp) return <Loading error={error} />;
  const c = cmp.current;
  const d = cmp.deltas;
  const buckets: any[] = series?.current?.buckets ?? [];
  const prevBuckets: any[] = series?.previous?.buckets ?? [];
  const label = (iso: string) => {
    const dt = new Date(`${iso}T00:00:00Z`);
    return series?.current?.granularity === "month" ? dt.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }) : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const points = (key: string): Point[] => buckets.map((b, i) => ({ label: label(b.date), value: b[key], prev: prevBuckets[i]?.[key] ?? null }));
  const moneyFmt = (v: number) => compact(v, { currency: cur });
  const countFmt = (v: number) => compact(v);
  const legend = <Legend items={[{ label: "this period" }, { label: "previous period", kind: "prev" }]} />;
  const stages: any[] = funnel?.stages ?? [];
  const maxStage = Math.max(1, ...stages.map((s) => s.value));

  return (
    <>
      <PageHeader title="Analytics" subtitle={`${date(range.from)} – ${date(range.to)} · compared with the ${cmp.previous ? `${date(cmp.previous.from)} – ${date(cmp.previous.to)}` : "previous"} period`} />
      <div className="actions" style={{ marginBottom: 16 }}>
        <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
          {PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom range…</option>
        </select>
        {preset === "custom" ? (
          <>
            <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} max={custom.to || isoDay(new Date())} />
            <span className="muted">to</span>
            <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} min={custom.from} max={isoDay(new Date())} />
          </>
        ) : null}
        <select value={granularity} onChange={(e) => setGranularity(e.target.value as never)} aria-label="Granularity">
          <option value="auto">Auto ({series?.current?.granularity ?? "…"})</option>
          <option value="day">By day</option>
          <option value="week">By week</option>
          <option value="month">By month</option>
        </select>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => reveal(exportCard.current)}>
          Export data
        </button>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <DeltaStat label="Affiliate-attributed revenue" value={money(c.attributedRevenueMinor, cur)} delta={d.attributedRevenueMinor} />
        <DeltaStat label="Attributed sales" value={c.attributedConversions.toLocaleString()} delta={d.attributedConversions} />
        <DeltaStat label="Clicks" value={c.clicks.toLocaleString()} delta={d.clicks} />
        <DeltaStat label="Conversion rate" value={percent(c.conversionRate)} delta={d.conversionRate} />
      </div>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <DeltaStat label="Commission earned by affiliates" value={money(c.commissionMinor, cur)} delta={d.commissionMinor} upIsGood={true} hint="cost · vs previous period" />
        <DeltaStat label="Average order" value={money(c.averageOrderMinor, cur)} delta={d.averageOrderMinor} />
        <DeltaStat label="New affiliates" value={c.newAffiliates.toLocaleString()} delta={d.newAffiliates} />
        <DeltaStat label="All revenue (incl. unattributed)" value={money(c.revenueMinor, cur)} delta={d.revenueMinor} />
      </div>

      <div className="grid cols-2">
        <ChartCard title="Attributed revenue" subtitle={`per ${series?.current?.granularity ?? "period"}`} legend={legend}>
          <SeriesChart points={points("attributedRevenueMinor")} kind="line" format={moneyFmt} />
        </ChartCard>
        <ChartCard title="Attributed sales" subtitle={`per ${series?.current?.granularity ?? "period"}`} legend={legend}>
          <SeriesChart points={points("attributedConversions")} kind="columns" format={countFmt} integer />
        </ChartCard>
        <ChartCard title="Clicks" subtitle={`per ${series?.current?.granularity ?? "period"}`} legend={legend}>
          <SeriesChart points={points("clicks")} kind="columns" format={countFmt} integer />
        </ChartCard>
        <ChartCard title="Commission created" subtitle={`per ${series?.current?.granularity ?? "period"}`} legend={legend}>
          <SeriesChart points={points("commissionMinor")} kind="line" format={moneyFmt} />
        </ChartCard>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Funnel</h2>
          <p className="muted">Clicks that became attributed sales, and sales that were approved.</p>
          {stages.map((s, i) => (
            <div key={s.key} className="funnel-row">
              <div className="funnel-label">
                <span>{s.label}</span>
                <span className="muted">
                  <strong style={{ color: "var(--text)" }}>{s.value.toLocaleString()}</strong>
                  {s.rateFromPrevious != null ? ` · ${percent(s.rateFromPrevious)} of previous` : ""}
                </span>
              </div>
              <div className="bar" style={{ height: 10 }}>
                <div className="fill" style={{ width: `${Math.max(2, (s.value / maxStage) * 100)}%`, opacity: 1 - i * 0.18 }} />
              </div>
            </div>
          ))}
          {funnel ? (
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Affiliates with clicks</dt>
              <dd>{funnel.activeAffiliatesWithClicks}</dd>
              <dt>Attributed by</dt>
              <dd>
                {funnel.bySource.link} link · {funnel.bySource.coupon} coupon · {funnel.bySource.manual} manual
              </dd>
              <dt>Unattributed sales</dt>
              <dd>{funnel.unattributedSales}</dd>
              <dt>Refunded</dt>
              <dd>{funnel.refundedSales}</dd>
            </dl>
          ) : null}
        </div>
        <div className="card">
          <h2>Groups</h2>
          <Table
            rows={byGroup?.rows}
            keyOf={(r: any) => r.groupId}
            empty="No groups yet. Create groups under Affiliates → Groups to compare partner types or channels."
            columns={[
              { header: "Group", cell: (r: any) => <Link href="/app/groups">{r.name}</Link> },
              { header: "Affiliates", cell: (r: any) => r.affiliates, num: true },
              { header: "Clicks", cell: (r: any) => r.clicks, num: true },
              { header: "Sales", cell: (r: any) => r.conversions, num: true },
              { header: "Revenue", cell: (r: any) => money(r.revenueMinor, cur), num: true },
              { header: "Commission", cell: (r: any) => money(r.commissionMinor, cur), num: true },
            ]}
          />
        </div>
      </div>

      <div className="card">
        <h2>Affiliates</h2>
        <Table
          rows={byAffiliate?.rows}
          keyOf={(r: any) => r.affiliateId}
          columns={[
            { header: "Affiliate", cell: (r: any) => <Link href={`/app/affiliates/${r.affiliateId}`}>{r.name}</Link> },
            { header: "Status", cell: (r: any) => <Badge value={r.status} /> },
            { header: "Clicks", cell: (r: any) => r.clicks, num: true },
            { header: "Conversions", cell: (r: any) => r.conversions, num: true },
            { header: "Revenue", cell: (r: any) => money(r.revenueMinor, cur), num: true },
            { header: "Commission", cell: (r: any) => money(r.commissionMinor, cur), num: true },
          ]}
        />
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Offers</h2>
          <Table
            rows={byOffer?.rows}
            keyOf={(r: any) => r.offerId}
            columns={[
              { header: "Offer", cell: (r: any) => r.name },
              { header: "Conversions", cell: (r: any) => r.conversions, num: true },
              { header: "Revenue", cell: (r: any) => money(r.revenueMinor, cur), num: true },
              { header: "Commission", cell: (r: any) => money(r.commissionMinor, cur), num: true },
            ]}
          />
        </div>
        <div className="card">
          <h2>Programs</h2>
          <Table
            rows={byProgram?.rows}
            keyOf={(r: any) => r.programId}
            columns={[
              { header: "Program", cell: (r: any) => <Link href={`/app/programs/${r.programId}`}>{r.name}</Link> },
              { header: "Active affiliates", cell: (r: any) => r.activeAffiliates, num: true },
              { header: "Revenue", cell: (r: any) => money(r.revenueMinor, cur), num: true },
              { header: "Commission", cell: (r: any) => money(r.commissionMinor, cur), num: true },
            ]}
          />
        </div>
        <div className="card">
          <h2>Campaigns</h2>
          <Table
            rows={byCampaign?.rows}
            keyOf={(r: any) => r.id}
            empty="No campaigns yet."
            columns={[
              { header: "Campaign", cell: (r: any) => <Link href={`/app/campaigns/${r.id}`}>{r.name}</Link> },
              { header: "Status", cell: (r: any) => <Badge value={r.status} /> },
              { header: "Active", cell: (r: any) => r.performance.participants.active, num: true },
              { header: "Sales", cell: (r: any) => r.performance.conversions, num: true },
              { header: "Revenue", cell: (r: any) => money(r.performance.revenueMinor, cur), num: true },
              { header: "Cost", cell: (r: any) => money(r.performance.commissionMinor + r.performance.bonusesMinor, cur), num: true },
            ]}
          />
        </div>
        <div className="card">
          <h2>Attribution source</h2>
          <Table
            rows={bySource?.rows}
            keyOf={(r: any) => r.source}
            columns={[
              { header: "Source", cell: (r: any) => r.source },
              { header: "Conversions", cell: (r: any) => r.conversions, num: true },
              { header: "Revenue", cell: (r: any) => money(r.revenueMinor, cur), num: true },
            ]}
          />
        </div>
      </div>

      <div className="card" id="exports" ref={exportCard}>
        <h2>Export data</h2>
        <p className="muted">
          Get your records as a file for a spreadsheet or your accountant. The file is prepared in the background: carry on working, and a notice tells you the moment it is ready. Files stay here for {exportsData?.ttlDays ?? 7} days.
        </p>
        <Alert kind="error">{exportError}</Alert>

        <h3>1. What do you need?</h3>
        <div className="choice-grid" role="radiogroup" aria-label="What to export">
          {datasets.map((x) => {
            const locked = x.ownerOnly && !isOwner;
            return (
              <label key={x.id} className={`choice${x.id === dataset?.id ? " selected" : ""}${locked ? " locked" : ""}`}>
                <input type="radio" name="export-dataset" value={x.id} checked={x.id === dataset?.id} disabled={locked} onChange={() => setExportEntity(x.id)} />
                <span className="choice-body">
                  <span className="choice-title">
                    {x.label} <span className="choice-format">{x.format === "json" ? "JSON" : "CSV"}</span>
                  </span>
                  <span className="muted small">{x.description}</span>
                </span>
              </label>
            );
          })}
        </div>

        <h3>2. Which records?</h3>
        {dataset?.period === "none" ? (
          <p className="muted">A backup always contains everything.</p>
        ) : (
          <div className="choice-list" role="radiogroup" aria-label="Which records">
            <label className="checkbox">
              <input type="radio" name="export-scope" checked={wholePeriod === "period"} onChange={() => setExportScope("period")} /> {date(range.from)} – {date(range.to)}
              <span className="muted"> · the period chosen at the top of this page</span>
            </label>
            <label className="checkbox">
              <input type="radio" name="export-scope" checked={wholePeriod === "all"} disabled={dataset?.period === "required"} onChange={() => setExportScope("all")} /> Everything, from the beginning
              {dataset?.period === "required" ? <span className="muted"> · a report is always for a period</span> : null}
            </label>
            {dataset?.datedBy && wholePeriod === "period" ? <p className="muted small">Records are picked by {dataset.datedBy}.</p> : null}
          </div>
        )}

        <div className="actions export-go">
          <button className="primary" type="button" disabled={busy || !dataset} onClick={prepareExport}>
            {busy ? "Starting…" : "Prepare the file"}
          </button>
          {pending ? <span className="muted">Preparing your file… you can leave this page; you will be told when it is ready.</span> : null}
        </div>

        <h3 id="export-files">Your files</h3>
        {files.length === 0 ? (
          <div className="empty">Nothing prepared yet. Files you ask for appear here, ready to download.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asked for</th>
                  <th>File</th>
                  <th>Covers</th>
                  <th>Status</th>
                  <th className="num">Rows</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f: any) => (
                  <tr key={f.id} id={`export-${f.id}`} className={f.id === readyId ? "row-ready" : undefined}>
                    <td>{dateTime(f.createdAt)}</td>
                    <td>
                      {f.label}
                      <div className="muted small mono">{f.fileName}</div>
                    </td>
                    <td>{f.periodFrom && f.periodTo ? `${date(f.periodFrom)} – ${date(f.periodTo)}` : "Everything"}</td>
                    <td>
                      <Badge value={FILE_STATUS[f.status] ?? f.status} />
                      {f.error ? <div className="muted small">{f.error}</div> : null}
                    </td>
                    <td className="num">{f.rowCount ?? "—"}</td>
                    <td>
                      {f.status === "done" ? (
                        f.expiresAt && new Date(f.expiresAt).getTime() < Date.now() ? (
                          <span className="muted small">expired</span>
                        ) : (
                          <button className={`sm${f.id === readyId ? " primary" : ""}`} type="button" onClick={() => download(f)}>
                            Download
                          </button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
