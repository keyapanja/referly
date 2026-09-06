"use client";

import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Badge, PageHeader, Table } from "@/components/ui";

export default function PortalPayouts() {
  const { data } = useApi<any>("/portal/payouts");
  const { data: me } = useApi<any>("/portal/me");
  return (
    <>
      <PageHeader title="Payouts" subtitle={me?.affiliate?.payoutMethod ? `Paid via ${me.affiliate.payoutMethod.replace("_", " ")} · ${me.affiliate.payoutDetailsMasked ?? ""}` : <>No payout method yet. <Link href="/portal/profile">Add one</Link>.</>} />
      <div className="card">
        <Table
          rows={data?.payouts}
          keyOf={(p: any) => p.id}
          empty="No payouts yet."
          columns={[
            { header: "Created", cell: (p: any) => dateTime(p.createdAt) },
            { header: "Amount", cell: (p: any) => money(p.amountMinor, p.currency), num: true },
            { header: "Method", cell: (p: any) => p.method ?? "—" },
            { header: "Reference", cell: (p: any) => <span className="mono">{p.externalReference ?? "—"}</span> },
            { header: "Paid", cell: (p: any) => dateTime(p.paidAt) },
            { header: "Status", cell: (p: any) => <Badge value={p.status} /> },
          ]}
        />
      </div>
    </>
  );
}
