"use client";

import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { dateTime, money, percent } from "@/lib/format";
import { Badge, CopyBox, Loading, PageHeader, Stat, Table } from "@/components/ui";

/** Affiliate home (PRD s8.1, s16.2): earnings first, then promotion activity and quick actions. */
export default function PortalHome() {
  const { data: me } = useApi<any>("/portal/me");
  const { data, error } = useApi<any>("/portal/home");
  if (!data) return <Loading error={error} />;
  const cur = data.balances.currency ?? me?.tenant?.currency ?? "USD";
  return (
    <>
      <PageHeader title={`Hi ${me?.affiliate?.name?.split(" ")[0] ?? ""}`} subtitle={`Promoting ${me?.tenant?.name ?? ""}`} />
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Available earnings" value={money(data.balances.availableMinor, cur)} hint="approved and ready for payout" />
        <Stat label="Pending earnings" value={money(data.balances.pendingMinor, cur)} hint="inside the holding period" />
        <Stat label="Clicks" value={data.metrics.clicks} hint={`${percent(data.metrics.conversionRate)} conversion rate`} />
        <Stat label="Revenue generated" value={money(data.metrics.revenueMinor, cur)} hint={`${data.metrics.conversions} sales`} />
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Campaigns</h2>
          {data.campaigns?.length ? (
            <ul>
              {data.campaigns.map((c: any) => (
                <li key={c.id}>
                  <Link href="/portal/campaigns">{c.name}</Link> <span className="muted">· {c.participantStatus === "invited" ? "invitation waiting" : c.live ? "live" : "upcoming"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No campaigns right now.</p>
          )}
        </div>
        <div className="card">
          <h2>Quick actions</h2>
          {data.links.length === 0 ? (
            <p>
              <Link className="btn primary" href="/portal/offers">
                Get your first link
              </Link>
            </p>
          ) : (
            data.links.slice(0, 3).map((l: any) => (
              <div key={l.id} style={{ marginBottom: 8 }}>
                <CopyBox value={l.url} />
              </div>
            ))
          )}
          {data.codes.map((c: any) => (
            <div key={c.id} style={{ marginBottom: 8 }}>
              Code <CopyBox value={c.code} />
            </div>
          ))}
          <p className="muted" style={{ marginTop: 8 }}>
            <Link href="/portal/links">All links and codes</Link> · <Link href="/portal/offers">Offers to promote</Link>
          </p>
        </div>
        <div className="card">
          <h2>Payouts</h2>
          {data.lastPayout ? (
            <dl className="kv">
              <dt>Last payout</dt>
              <dd>
                {money(data.lastPayout.amountMinor, data.lastPayout.currency)} <Badge value={data.lastPayout.status} />
              </dd>
              <dt>When</dt>
              <dd>{dateTime(data.lastPayout.paidAt ?? data.lastPayout.createdAt)}</dd>
            </dl>
          ) : (
            <p className="muted">No payouts yet. Your available balance is paid out by the merchant on their schedule.</p>
          )}
          {!me?.affiliate?.payoutMethod ? (
            <p>
              <Link href="/portal/profile">Add your payout details</Link> so you can get paid.
            </p>
          ) : null}
        </div>
      </div>
      <div className="card">
        <h2>Recent sales</h2>
        <Table
          rows={data.recentConversions}
          keyOf={(c: any) => c.id}
          empty="No sales attributed yet. Share your link to get started."
          columns={[
            { header: "When", cell: (c: any) => dateTime(c.occurredAt) },
            { header: "Amount", cell: (c: any) => money(c.amountMinor - c.refundedAmountMinor, c.currency), num: true },
            { header: "Attributed by", cell: (c: any) => c.attributionSource },
            { header: "Status", cell: (c: any) => <Badge value={c.status} /> },
          ]}
        />
      </div>
    </>
  );
}
