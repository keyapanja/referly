"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Alert, Badge, PageHeader, Table } from "@/components/ui";

function CommissionsList() {
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const { data, error, reload } = useApi<any>(`/v1/commissions${status ? `?status=${status}` : ""}`);
  const { data: affiliates } = useApi<any>("/v1/affiliates");
  const { busy, error: actionError, success, run } = useAction();
  const name = (id: string) => affiliates?.affiliates?.find((a: any) => a.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title="Commissions"
        subtitle="Pending commissions become payable when the holding period ends."
        actions={
          <>
            <select value={status} onChange={(e) => (window.location.search = e.target.value ? `?status=${e.target.value}` : "")}>
              <option value="">All statuses</option>
              {["pending", "approved", "payable", "paid", "reversed", "void"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <button className="primary" disabled={busy} onClick={() => run(async () => { const r = await api<any>("/v1/commissions/settle", { method: "POST" }); return r.settled.length; }, undefined).then((n) => { if (n !== undefined) { reload(); } })}>
              Settle holding periods
            </button>
          </>
        }
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="card">
        <Table
          rows={data?.commissions}
          keyOf={(c: any) => c.id}
          empty="No commissions."
          columns={[
            { header: "Created", cell: (c: any) => <Link href={`/app/conversions/${c.conversionId}`}>{dateTime(c.createdAt)}</Link> },
            { header: "Affiliate", cell: (c: any) => <Link href={`/app/affiliates/${c.affiliateId}`}>{name(c.affiliateId)}</Link> },
            { header: "Amount", cell: (c: any) => money(c.amountMinor, c.currency), num: true },
            { header: "Payable from", cell: (c: any) => dateTime(c.payableAt) },
            { header: "Status", cell: (c: any) => <>{<Badge value={c.status} />}{c.isTest ? <> <Badge value="test" /></> : null}</> },
            {
              header: "",
              cell: (c: any) => (
                <span className="actions">
                  {c.status === "pending" && (
                    <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/commissions/${c.id}/approve`, { method: "POST", json: {} })).then(reload)}>
                      Approve
                    </button>
                  )}
                  {["pending", "approved", "payable"].includes(c.status) && (
                    <button
                      className="sm danger"
                      disabled={busy}
                      onClick={() => {
                        const r = window.prompt("Reason for reversal:");
                        if (r) run(() => api(`/v1/commissions/${c.id}/reverse`, { method: "POST", json: { reason: r } })).then(reload);
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
