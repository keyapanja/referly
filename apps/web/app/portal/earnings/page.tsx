"use client";

import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Loading, PageHeader, Stat, Table } from "@/components/ui";

export default function PortalEarnings() {
  const [from, setFrom] = useState(new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const { data, error } = useApi<any>(`/portal/earnings?from=${from}T00:00:00Z&to=${to}T23:59:59Z`);
  if (!data) return <Loading error={error} />;
  const cur = data.balances.currency ?? "USD";
  return (
    <>
      <PageHeader
        title="Earnings"
        subtitle="Statement of every credit, reversal, adjustment and payout."
        actions={
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <button onClick={() => window.print()}>Print / save PDF</button>
          </>
        }
      />
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Pending" value={money(data.balances.pendingMinor, cur)} />
        <Stat label="Available" value={money(data.balances.availableMinor, cur)} />
        <Stat label="In payout batch" value={money(data.balances.reservedMinor, cur)} />
        <Stat label="Paid to date" value={money(data.balances.paidMinor, cur)} />
      </div>
      <div className="card">
        <h2>Period totals</h2>
        <dl className="kv">
          <dt>Commissions earned</dt>
          <dd>{money(data.totals.credit, cur)}</dd>
          <dt>Reversals</dt>
          <dd>{money(data.totals.reversal + data.totals.clawback, cur)}</dd>
          <dt>Adjustments</dt>
          <dd>{money(data.totals.adjustment, cur)}</dd>
          <dt>Paid out</dt>
          <dd>{money(data.totals.payout, cur)}</dd>
          <dt>Net movement</dt>
          <dd>
            <strong>{money(data.netMinor, cur)}</strong>
          </dd>
        </dl>
      </div>
      <div className="card">
        <h2>Entries</h2>
        <Table
          rows={data.entries}
          keyOf={(e: any) => e.id}
          empty="No activity in this period."
          columns={[
            { header: "When", cell: (e: any) => dateTime(e.createdAt) },
            { header: "Type", cell: (e: any) => e.type },
            { header: "Amount", cell: (e: any) => money(e.amountMinor, e.currency), num: true },
            { header: "Note", cell: (e: any) => e.reason ?? "—" },
          ]}
        />
      </div>
    </>
  );
}
