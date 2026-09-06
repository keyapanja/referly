"use client";

import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { money, percent } from "@/lib/format";
import { Loading, PageHeader, Stat, Table } from "@/components/ui";

/** Merchant home (PRD s16.1): snapshot + needs attention. */
export default function MerchantHome() {
  const { data: me } = useApi<any>("/v1/tenant/me");
  const { data, error } = useApi<any>("/v1/analytics/overview");
  const cur = me?.tenant?.currency ?? "USD";
  if (!data) return <Loading error={error} />;
  const cs = data.commissionByStatus ?? {};
  const attention: { label: string; count: number; href: string }[] = [
    { label: "Pending applications", count: data.needsAttention.pendingApplications, href: "/app/affiliates?status=applied" },
    { label: "Draft payout batches", count: data.needsAttention.draftPayouts, href: "/app/payouts" },
    { label: "Failed payouts", count: data.needsAttention.failedPayouts, href: "/app/payouts?status=failed" },
    { label: "Disputed conversions", count: data.needsAttention.disputes, href: "/app/conversions?status=disputed" },
  ].filter((a) => a.count > 0);

  return (
    <>
      <PageHeader title="Home" subtitle="Last 30 days" />
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Affiliate-attributed revenue" value={money(data.attributedRevenueMinor, cur)} hint={`${data.attributedConversions} conversions`} />
        <Stat label="Clicks" value={data.clicks} hint={`${percent(data.conversionRate)} conversion rate`} />
        <Stat label="Active affiliates" value={data.activeAffiliates} />
        <Stat label="Commissions payable" value={money(cs.payable?.totalMinor ?? 0, cur)} hint={`${money(cs.pending?.totalMinor ?? 0, cur)} pending`} />
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Needs attention</h2>
          {attention.length === 0 ? (
            <div className="empty">All clear.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {attention.map((a) => (
                <li key={a.label}>
                  <Link href={a.href}>
                    {a.count} {a.label.toLowerCase()}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Payouts</h2>
          <dl className="kv">
            <dt>Draft</dt>
            <dd>{money(data.payoutsByStatus.draft?.totalMinor ?? 0, cur)}</dd>
            <dt>Processing</dt>
            <dd>{money(data.payoutsByStatus.processing?.totalMinor ?? 0, cur)}</dd>
            <dt>Paid (all time)</dt>
            <dd>{money(data.payoutsByStatus.paid?.totalMinor ?? 0, cur)}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Top affiliates</h2>
          <Table
            rows={data.topAffiliates.filter((a: any) => a.revenueMinor > 0)}
            keyOf={(r: any) => r.affiliateId}
            empty="No attributed revenue yet."
            columns={[
              { header: "Affiliate", cell: (r: any) => <Link href={`/app/affiliates/${r.affiliateId}`}>{r.name}</Link> },
              { header: "Conversions", cell: (r: any) => r.conversions, num: true },
              { header: "Revenue", cell: (r: any) => money(r.revenueMinor, cur), num: true },
            ]}
          />
        </div>
        <div className="card">
          <h2>Top offers</h2>
          <Table
            rows={data.topOffers.filter((o: any) => o.revenueMinor > 0)}
            keyOf={(r: any) => r.offerId}
            empty="No attributed revenue yet."
            columns={[
              { header: "Offer", cell: (r: any) => r.name },
              { header: "Conversions", cell: (r: any) => r.conversions, num: true },
              { header: "Revenue", cell: (r: any) => money(r.revenueMinor, cur), num: true },
            ]}
          />
        </div>
      </div>
    </>
  );
}
