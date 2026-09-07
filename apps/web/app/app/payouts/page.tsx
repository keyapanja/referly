"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

function PayoutsList() {
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const { data, error, reload } = useApi<any>(`/v1/payouts${status ? `?status=${status}` : ""}`);
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { busy, error: actionError, success, run } = useAction();
  const [external, setExternal] = useState({ affiliateId: "", reference: "", method: "bank_transfer" });
  const [single, setSingle] = useState("");
  const name = (id: string) => affiliates?.affiliates?.find((a: any) => a.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title="Payouts"
        subtitle="Batch payable commissions per affiliate, pay them outside the platform, then record completion."
        actions={
          <>
            <select value={status} onChange={(e) => (window.location.search = e.target.value ? `?status=${e.target.value}` : "")}>
              <option value="">All statuses</option>
              {["draft", "processing", "paid", "failed", "cancelled"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            {data?.connectedProviders?.length && data?.payouts?.some((p: any) => p.canSend) ? (
              <button disabled={busy} onClick={() => run(async () => { const r = await api<any>("/v1/payouts/send-all", { method: "POST" }); return `${r.queued.length} sent to providers${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}.`; }, undefined).then(reload)}>
                Send all drafts via providers
              </button>
            ) : null}
            <button className="primary" disabled={busy} onClick={() => run(async () => { const r = await api<any>("/v1/payouts/batch-all", { method: "POST" }); return r.payouts.length; }).then((n) => { if (n !== undefined) reload(); })}>
              Create batches for everyone payable
            </button>
          </>
        }
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Create a batch for one affiliate</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api("/v1/payouts", { method: "POST", json: { affiliateId: single } }), "Draft batch created.");
              if (ok) reload();
            }}
          >
            <Field label="Affiliate">
              <select value={single} onChange={(e) => setSingle(e.target.value)} required>
                <option value="">Choose…</option>
                {affiliates?.affiliates?.map((a: any) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <button disabled={busy}>Create draft batch</button>
          </form>
        </div>
        <div className="card">
          <h2>Record an external payout</h2>
          <p className="muted">Already paid this affiliate? This batches everything payable and marks it paid with your reference.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api("/v1/payouts/external", { method: "POST", json: { affiliateId: external.affiliateId, externalReference: external.reference, method: external.method } }), "Payout recorded.");
              if (ok) {
                setExternal({ affiliateId: "", reference: "", method: "bank_transfer" });
                reload();
              }
            }}
          >
            <div className="row">
              <Field label="Affiliate">
                <select value={external.affiliateId} onChange={(e) => setExternal({ ...external, affiliateId: e.target.value })} required>
                  <option value="">Choose…</option>
                  {affiliates?.affiliates?.map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference (bank / transfer id)">
                <input value={external.reference} onChange={(e) => setExternal({ ...external, reference: e.target.value })} required />
              </Field>
            </div>
            <button disabled={busy}>Record paid</button>
          </form>
        </div>
      </div>
      <div className="card">
        <Table
          rows={data?.payouts}
          keyOf={(p: any) => p.id}
          empty="No payouts yet."
          columns={[
            { header: "Created", cell: (p: any) => dateTime(p.createdAt) },
            { header: "Affiliate", cell: (p: any) => <Link href={`/app/affiliates/${p.affiliateId}`}>{name(p.affiliateId)}</Link> },
            { header: "Amount", cell: (p: any) => money(p.amountMinor, p.currency), num: true },
            { header: "Method", cell: (p: any) => <>{p.method ?? p.payoutMethod ?? "—"}{p.provider ? <div className="muted">{p.provider === "stripe_connect" ? "Stripe" : "PayPal"}{p.providerStatus ? ` · ${p.providerStatus}` : ""}</div> : null}</> },
            { header: "Reference", cell: (p: any) => <span className="mono">{p.externalReference ?? p.providerRef ?? p.failureReason ?? "—"}</span> },
            { header: "Status", cell: (p: any) => <Badge value={p.status} /> },
            {
              header: "",
              cell: (p: any) => (
                <span className="actions">
                  {p.canSend ? (
                    <button className="sm primary" disabled={busy} onClick={() => run(() => api(`/v1/payouts/${p.id}/send`, { method: "POST" }), `Sending via ${p.providerId === "paypal" ? "PayPal" : "Stripe"}…`).then(reload)}>
                      Send via {p.providerId === "paypal" ? "PayPal" : "Stripe"}
                    </button>
                  ) : null}
                  {p.status === "draft" && (
                    <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/payouts/${p.id}/processing`, { method: "POST" })).then(reload)}>
                      Start
                    </button>
                  )}
                  {["draft", "processing"].includes(p.status) && (
                    <button
                      className="sm primary"
                      disabled={busy}
                      onClick={() => {
                        const ref = window.prompt("Payment reference (optional):") ?? "";
                        run(() => api(`/v1/payouts/${p.id}/paid`, { method: "POST", json: { externalReference: ref || undefined } })).then(reload);
                      }}
                    >
                      Mark paid
                    </button>
                  )}
                  {p.status === "processing" && (
                    <button
                      className="sm danger"
                      disabled={busy}
                      onClick={() => {
                        const r = window.prompt("Failure reason:");
                        if (r) run(() => api(`/v1/payouts/${p.id}/failed`, { method: "POST", json: { reason: r } })).then(reload);
                      }}
                    >
                      Failed
                    </button>
                  )}
                  {p.status === "failed" && (
                    <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/payouts/${p.id}/processing`, { method: "POST" })).then(reload)}>
                      Retry
                    </button>
                  )}
                  {["draft", "failed"].includes(p.status) && (
                    <button
                      className="sm"
                      disabled={busy}
                      onClick={() => {
                        const r = window.prompt("Cancel reason:");
                        if (r) run(() => api(`/v1/payouts/${p.id}/cancel`, { method: "POST", json: { reason: r } })).then(reload);
                      }}
                    >
                      Cancel
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

export default function PayoutsPage() {
  return (
    <Suspense>
      <PayoutsList />
    </Suspense>
  );
}
