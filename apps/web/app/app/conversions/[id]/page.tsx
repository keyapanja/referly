"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money, toMinor } from "@/lib/format";
import { Alert, Badge, Field, Loading, PageHeader, Table } from "@/components/ui";

export default function ConversionDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<any>(`/v1/conversions/${id}`);
  const { data: audit, reload: reloadAudit } = useApi<any>(`/v1/tenant/audit?entityType=conversion&entityId=${id}`);
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { busy, error: actionError, run } = useAction();
  const [refund, setRefund] = useState({ amount: "", reason: "" });
  const [reattr, setReattr] = useState({ affiliateId: "", reason: "" });

  if (!data) return <Loading error={error} />;
  const c = data.conversion;
  const refresh = () => {
    reload();
    reloadAudit();
  };
  const remaining = c.amountMinor - c.refundedAmountMinor;

  return (
    <>
      <PageHeader
        title={`Order ${c.externalOrderId}`}
        subtitle={
          <>
            {dateTime(c.occurredAt)} · <Badge value={c.status} /> · {c.source}
          </>
        }
        actions={
          <>
            {c.status === "pending" && (
              <button disabled={busy} onClick={() => run(() => api(`/v1/conversions/${id}/approve`, { method: "POST" })).then(refresh)}>
                Approve
              </button>
            )}
            {["pending", "approved"].includes(c.status) && (
              <button
                disabled={busy}
                onClick={() => {
                  const r = window.prompt("Dispute reason:");
                  if (r) run(() => api(`/v1/conversions/${id}/dispute`, { method: "POST", json: { reason: r } })).then(refresh);
                }}
              >
                Dispute
              </button>
            )}
            {["pending", "disputed"].includes(c.status) && (
              <button
                className="danger"
                disabled={busy}
                onClick={() => {
                  const r = window.prompt("Cancel reason:");
                  if (r) run(() => api(`/v1/conversions/${id}/cancel`, { method: "POST", json: { reason: r } })).then(refresh);
                }}
              >
                Cancel
              </button>
            )}
          </>
        }
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Order</h2>
          <dl className="kv">
            <dt>Amount</dt>
            <dd>{money(c.amountMinor, c.currency)}</dd>
            <dt>Net</dt>
            <dd>{money(c.netAmountMinor, c.currency)}</dd>
            <dt>Refunded</dt>
            <dd>{money(c.refundedAmountMinor, c.currency)}</dd>
            <dt>Customer</dt>
            <dd>{c.customerRef ?? (c.customerEmailHash ? "hashed email" : "—")}</dd>
            <dt>Affiliate</dt>
            <dd>{c.affiliateId ? <Link href={`/app/affiliates/${c.affiliateId}`}>{affiliates?.affiliates?.find((a: any) => a.id === c.affiliateId)?.name ?? c.affiliateId}</Link> : "unattributed"}</dd>
            <dt>Attribution</dt>
            <dd>{c.attributionSource}</dd>
            {c.isTest ? (
              <>
                <dt>Mode</dt>
                <dd>
                  <Badge value="test" />
                </dd>
              </>
            ) : null}
          </dl>
        </div>
        <div className="card">
          <h2>Commission</h2>
          {data.commission ? (
            <dl className="kv">
              <dt>Status</dt>
              <dd>
                <Badge value={data.commission.status} />
              </dd>
              <dt>Amount</dt>
              <dd>
                {money(data.commission.amountMinor, data.commission.currency)} <span className="muted">(originally {money(data.commission.originalAmountMinor, data.commission.currency)})</span>
              </dd>
              <dt>Basis</dt>
              <dd>
                {data.commission.calculationBasis.model === "percentage" ? `${data.commission.calculationBasis.rateBps / 100}% of ${data.commission.calculationBasis.basis} ${money(data.commission.calculationBasis.basisAmountMinor, data.commission.currency)}` : `fixed ${money(data.commission.calculationBasis.fixedMinor, data.commission.currency)}`}{" "}
                <span className="muted">({data.commission.calculationBasis.overrideSource.replace("_", " ")})</span>
              </dd>
              <dt>Payable from</dt>
              <dd>{dateTime(data.commission.payableAt)}</dd>
            </dl>
          ) : (
            <div className="empty">No commission (unattributed).</div>
          )}
          {data.commissionHistory?.length > 1 ? <p className="muted">{data.commissionHistory.length - 1} earlier commission(s) voided by reattribution.</p> : null}
        </div>
      </div>
      <div className="card">
        <h2>Attribution history</h2>
        <Table
          rows={data.attributions}
          keyOf={(a: any) => a.id}
          empty="No attribution."
          columns={[
            { header: "When", cell: (a: any) => dateTime(a.attributedAt) },
            { header: "Rule", cell: (a: any) => a.ruleApplied.replace("_", " ") },
            { header: "Affiliate", cell: (a: any) => affiliates?.affiliates?.find((x: any) => x.id === a.affiliateId)?.name ?? a.affiliateId },
            { header: "Evidence", cell: (a: any) => <span className="mono">{a.clickId ?? a.couponCodeId ?? a.reason ?? "—"}</span> },
            {
              header: "Candidates considered",
              cell: (a: any) => (
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {a.candidates.map((k: any, i: number) => (
                    <li key={i}>
                      {k.rule} · {k.eligible ? "eligible" : `ineligible (${k.ineligibleReason})`}
                    </li>
                  ))}
                </ul>
              ),
            },
            { header: "", cell: (a: any) => (a.supersededById ? <Badge value="superseded" /> : <Badge value="active" />) },
          ]}
        />
      </div>
      <div className="grid cols-2">
        {remaining > 0 && !["cancelled", "reversed"].includes(c.status) && (
          <div className="card">
            <h2>Refund</h2>
            <p className="muted">Remaining {money(remaining, c.currency)}. Commission changes follow the program's refund policy.</p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await run(() => api(`/v1/conversions/${id}/refund`, { method: "POST", json: { amountMinor: refund.amount ? toMinor(refund.amount) : undefined, reason: refund.reason } }));
                if (ok) {
                  setRefund({ amount: "", reason: "" });
                  refresh();
                }
              }}
            >
              <div className="row">
                <Field label="Amount (blank = full remaining)">
                  <input value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
                </Field>
                <Field label="Reason">
                  <input value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} required />
                </Field>
              </div>
              <button className="danger" disabled={busy}>
                Record refund
              </button>
            </form>
          </div>
        )}
        {data.commission?.status !== "paid" && !["cancelled", "reversed"].includes(c.status) && (
          <div className="card">
            <h2>Correct attribution</h2>
            <p className="muted">Voids the current commission and creates a new one for the chosen affiliate. Reason is required and audited.</p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await run(() => api(`/v1/conversions/${id}/reattribute`, { method: "POST", json: { affiliateId: reattr.affiliateId || null, programId: c.programId ?? undefined, reason: reattr.reason } }));
                if (ok) {
                  setReattr({ affiliateId: "", reason: "" });
                  refresh();
                }
              }}
            >
              <div className="row">
                <Field label="Affiliate">
                  <select value={reattr.affiliateId} onChange={(e) => setReattr({ ...reattr, affiliateId: e.target.value })}>
                    <option value="">Remove attribution</option>
                    {affiliates?.affiliates?.map((a: any) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reason">
                  <input value={reattr.reason} onChange={(e) => setReattr({ ...reattr, reason: e.target.value })} required />
                </Field>
              </div>
              <button disabled={busy}>Reattribute</button>
            </form>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Audit trail</h2>
        <Table
          rows={audit?.entries}
          keyOf={(e: any) => e.id}
          columns={[
            { header: "When", cell: (e: any) => dateTime(e.createdAt) },
            { header: "Action", cell: (e: any) => e.action },
            { header: "Actor", cell: (e: any) => e.actorType },
            { header: "Reason", cell: (e: any) => e.reason ?? "—" },
            { header: "Change", cell: (e: any) => <span className="mono">{e.before ? JSON.stringify(e.before) + " → " : ""}{e.after ? JSON.stringify(e.after).slice(0, 120) : ""}</span> },
          ]}
        />
      </div>
    </>
  );
}
