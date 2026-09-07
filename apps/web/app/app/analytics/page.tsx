"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { API_URL, api, getToken } from "@/lib/api";
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
  const { busy, error: exportError, run } = useAction();
  const [exportEntity, setExportEntity] = useState("conversions");
  const pending = exportsData?.exports?.some((e: any) => e.status === "queued" || e.status === "running");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(reloadExports, 2500);
    return () => clearInterval(t);
  }, [pending, reloadExports]);

  async function download(exp: any) {
    const res = await fetch(`${API_URL}/v1/analytics/exports/${exp.id}/download`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exp.entity}-${String(exp.createdAt).slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
        <select value={exportEntity} onChange={(e) => setExportEntity(e.target.value)} aria-label="Data to export">
          {(exportsData?.entities ?? ["affiliates", "conversions", "commissions", "payouts"]).map((e: string) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        <button disabled={busy} onClick={() => run(() => api("/v1/analytics/exports", { method: "POST", json: { entity: exportEntity } }), "Export started.").then(reloadExports)}>
          Export CSV
        </button>
      </div>
      <Alert kind="error">{exportError}</Alert>

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
          <SeriesChart points={points("attributedConversions")} kind="columns" format={countFmt} />
        </ChartCard>
        <ChartCard title="Clicks" subtitle={`per ${series?.current?.granularity ?? "period"}`} legend={legend}>
          <SeriesChart points={points("clicks")} kind="columns" format={countFmt} />
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

      {exportsData?.exports?.length ? (
        <div className="card">
          <h2>Exports</h2>
          <p className="muted">Exports are built in the background and stay downloadable for 7 days.</p>
          <Table
            rows={exportsData.exports}
            keyOf={(e: any) => e.id}
            columns={[
              { header: "Requested", cell: (e: any) => dateTime(e.createdAt) },
              { header: "Data", cell: (e: any) => e.entity },
              { header: "Status", cell: (e: any) => <><Badge value={e.status} /> {e.error ? <span className="muted">{e.error}</span> : null}</> },
              { header: "Rows", cell: (e: any) => e.rowCount ?? "—", num: true },
              { header: "", cell: (e: any) => (e.status === "done" ? <button className="sm" onClick={() => download(e)}>Download</button> : null) },
            ]}
          />
        </div>
      ) : null}

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
    </>
  );
}
