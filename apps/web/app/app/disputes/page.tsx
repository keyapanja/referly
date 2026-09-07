"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Badge, PageHeader, Table } from "@/components/ui";

const KIND: Record<string, string> = { attribution: "Attribution", amount: "Amount", fraud: "Fraud / invalid sale", refund: "Refund", other: "Other" };

export default function DisputesPage() {
  const [status, setStatus] = useState("open");
  const { data, error } = useApi<any>(`/v1/disputes${status ? `?status=${status}` : ""}`);
  const { data: me } = useApi<any>("/v1/tenant/me");
  const cur = me?.tenant?.currency ?? "USD";
  return (
    <>
      <PageHeader
        title="Disputes"
        subtitle="Contested sales and attribution claims. Open disputes hold the related commission until they are resolved."
        actions={
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="under_review">Under review</option>
            <option value="resolved">Resolved</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        }
      />
      {error ? <div className="alert error">{error}</div> : null}
      <div className="card">
        <Table
          rows={data?.disputes}
          keyOf={(d: any) => d.id}
          empty="No disputes."
          columns={[
            { header: "Opened", cell: (d: any) => dateTime(d.createdAt) },
            { header: "Dispute", cell: (d: any) => <><Link href={`/app/disputes/${d.id}`}><strong>{KIND[d.kind] ?? d.kind}</strong></Link><div className="muted" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.reason}</div></> },
            { header: "Raised by", cell: (d: any) => (d.raisedBy === "affiliate" ? `Affiliate · ${d.affiliateName ?? ""}` : `Merchant · about ${d.affiliateName ?? "—"}`) },
            { header: "Sale", cell: (d: any) => (d.conversion ? <Link href={`/app/conversions/${d.conversion.id}`}>{d.conversion.externalOrderId} · {money(d.conversion.amountMinor, d.conversion.currency ?? cur)}</Link> : <span className="muted">{d.orderReference ? `ref ${d.orderReference}` : "not linked"}</span>) },
            { header: "Status", cell: (d: any) => <><Badge value={d.status} />{d.resolution ? <span className="muted"> · {d.resolution}</span> : null}</> },
          ]}
        />
      </div>
    </>
  );
}
