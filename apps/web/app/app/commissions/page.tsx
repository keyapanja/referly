"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { StatusFilter, STATUS_OPTIONS } from "@/components/status-filter";
import { Suspense } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Alert, Badge, PageHeader, Table } from "@/components/ui";
import { askReason } from "@/components/dialog";

function CommissionsList() {
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const { data, error, reload } = useApi<any>(`/v1/commissions${status ? `?status=${status}` : ""}`);
  const { busy, run } = useAction();
  const name = (c: any) => c.affiliateName ?? "Unknown affiliate";

  return (
    <>
      <PageHeader
        title="Commissions"
        subtitle="A commission is held until its program's holding period ends, then turns payable and can go into a payout. Pay now releases one early."
        actions={
          <>
            <StatusFilter options={STATUS_OPTIONS.commissions} />
            <button className="primary" disabled={busy} onClick={() => run(async () => { const r = await api<any>("/v1/commissions/settle", { method: "POST" }); return r.settled.length; }, undefined).then((n) => { if (n !== undefined) { reload(); } })}>
              Settle holding periods
            </button>
          </>
        }
      />
      <Alert kind="error">{error}</Alert>
      <div className="card">
        <Table
          rows={data?.commissions}
          keyOf={(c: any) => c.id}
          empty="No commissions."
          columns={[
            { header: "Created", cell: (c: any) => <Link href={`/app/conversions/${c.conversionId}`}>{dateTime(c.createdAt)}</Link> },
            { header: "Affiliate", cell: (c: any) => <Link href={`/app/affiliates/${c.affiliateId}`}>{name(c)}</Link> },
            { header: "Amount", cell: (c: any) => money(c.amountMinor, c.currency), num: true },
            { header: "Payable from", cell: (c: any) => dateTime(c.payableAt) },
            { header: "Status", cell: (c: any) => <>{<Badge value={c.status} />}{c.isTest ? <> <Badge value="test" /></> : null}</> },
            {
              header: "",
              cell: (c: any) => (
                <span className="actions">
                  {["pending", "approved"].includes(c.status) && (
                    <button
                      className="sm"
                      disabled={busy}
                      title="Ends the holding period for this commission, so it can go into a payout today."
                      onClick={() => run(() => api(`/v1/commissions/${c.id}/release`, { method: "POST", json: {} }), "Released: it can go into a payout now.").then(reload)}
                    >
                      Pay now
                    </button>
                  )}
                  {["pending", "approved", "payable"].includes(c.status) && (
                    <button
                      className="sm danger"
                      disabled={busy}
                      onClick={async () => {
                        const r = await askReason({
                          title: `Reverse ${money(c.amountMinor, c.currency)} for ${name(c)}?`,
                          body: "The commission goes to zero and the affiliate sees the reversal, with your reason, on their statement. This cannot be undone.",
                          label: "Reason",
                          placeholder: "Refunded outside the platform, duplicate order…",
                          confirmLabel: "Reverse commission",
                          danger: true,
                        });
                        if (r) run(() => api(`/v1/commissions/${c.id}/reverse`, { method: "POST", json: { reason: r } }), "Commission reversed.").then(reload);
                      }}
                    >
                      Reverse
                    </button>
                  )}
                </span>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

export default function CommissionsPage() {
  return (
    <Suspense>
      <CommissionsList />
    </Suspense>
  );
}
