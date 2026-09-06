"use client";

import { useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Badge, Loading, PageHeader, Table } from "@/components/ui";

const EXPLAIN: Record<string, string> = {
  pending: "Commission is in the holding period.",
  approved: "Confirmed by the merchant; waiting for holding period.",
  payable: "Ready for the next payout.",
  paid: "Included in a completed payout.",
  reversed: "Order was refunded or cancelled.",
  void: "Replaced by a correction.",
};

export default function PortalConversions() {
  const { data, error } = useApi<any>("/portal/conversions");
  const { data: commissions } = useApi<any>("/portal/commissions");
  if (!data) return <Loading error={error} />;
  const commissionFor = (id: string) => commissions?.commissions?.filter((c: any) => c.conversionId === id).sort((a: any, b: any) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  return (
    <>
      <PageHeader title="Conversions" subtitle="Sales attributed to you and what each one earns." />
      <div className="card">
        <Table
          rows={data.conversions}
          keyOf={(c: any) => c.id}
          empty="No conversions yet."
          columns={[
            { header: "When", cell: (c: any) => dateTime(c.occurredAt) },
            { header: "Sale", cell: (c: any) => money(c.amountMinor - c.refundedAmountMinor, c.currency), num: true },
            { header: "Attributed by", cell: (c: any) => c.attributionSource },
            { header: "Order status", cell: (c: any) => <Badge value={c.status} /> },
            {
              header: "Commission",
              cell: (c: any) => {
                const k = commissionFor(c.id);
                return k ? (
                  <>
                    {money(k.amountMinor, k.currency)} <Badge value={k.status} />
                    <div className="help">{EXPLAIN[k.status]}</div>
                  </>
                ) : (
                  "—"
                );
              },
            },
          ]}
        />
      </div>
    </>
  );
}
