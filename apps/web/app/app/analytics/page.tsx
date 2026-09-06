"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { API_URL, api, getToken } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { money, percent } from "@/lib/format";
import { Alert, Badge, Loading, PageHeader, Stat, Table } from "@/components/ui";

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  // Memoised: a fresh timestamp on every render would change the query key and refetch forever.
  const from = useMemo(() => new Date(Date.now() - days * 86_400_000).toISOString(), [days]);
  const q = `?from=${encodeURIComponent(from)}`;
  const { data: me } = useApi<any>("/v1/tenant/me");
  const { data: overview, error } = useApi<any>(`/v1/analytics/overview${q}`);
  const { data: byAffiliate } = useApi<any>(`/v1/analytics/affiliates${q}`);
  const { data: byOffer } = useApi<any>(`/v1/analytics/offers${q}`);
  const { data: byProgram } = useApi<any>(`/v1/analytics/programs${q}`);
  const { data: bySource } = useApi<any>(`/v1/analytics/sources${q}`);
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

  if (!overview) return <Loading error={error} />;
  return (
    <>
      <PageHeader
        title="Analytics"
        actions={
          <>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
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
          </>
        }
      />
      <Alert kind="error">{exportError}</Alert>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Total revenue" value={money(overview.revenueMinor, cur)} hint={`${overview.conversions} conversions`} />
        <Stat label="Affiliate-attributed" value={money(overview.attributedRevenueMinor, cur)} hint={`${overview.attributedConversions} conversions`} />
        <Stat label="Clicks" value={overview.clicks} hint={`${percent(overview.conversionRate)} conversion rate`} />
        <Stat label="Commission cost" value={money((overview.commissionByStatus.pending?.totalMinor ?? 0) + (overview.commissionByStatus.approved?.totalMinor ?? 0) + (overview.commissionByStatus.payable?.totalMinor ?? 0) + (overview.commissionByStatus.paid?.totalMinor ?? 0), cur)} />
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
