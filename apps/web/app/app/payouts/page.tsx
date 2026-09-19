"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { StatusFilter, STATUS_OPTIONS } from "@/components/status-filter";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { date, dateTime, money } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";
import { askReason } from "@/components/dialog";

function PayoutsList() {
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const { data, error, reload } = useApi<any>(`/v1/payouts${status ? `?status=${status}` : ""}`);
  const { data: payable, error: payableError, reload: reloadPayable } = useApi<any>("/v1/payouts/payable");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { busy, run } = useAction();
  const [external, setExternal] = useState({ affiliateId: "", reference: "", method: "bank_transfer" });
  // The API names the affiliate on every row, suspended ones included; an id is never shown in its place.
  const name = (row: any) => row.affiliateName ?? "Unknown affiliate";
  const reloadAll = () => {
    reload();
    reloadPayable();
  };

  return (
    <>
      <PageHeader
        title="Payouts"
        subtitle="Batch payable commissions per affiliate, pay them outside the platform, then record completion."
        actions={
          <>
            <StatusFilter options={STATUS_OPTIONS.payouts} />
            {data?.connectedProviders?.length && data?.payouts?.some((p: any) => p.canSend) ? (
              <button disabled={busy} onClick={() => run(async () => { const r = await api<any>("/v1/payouts/send-all", { method: "POST" }); return `${r.queued.length} sent to providers${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}.`; }, undefined).then(reloadAll)}>
                Send all drafts via providers
              </button>
            ) : null}
            <button className="primary" disabled={busy} onClick={() => run(async () => { const r = await api<any>("/v1/payouts/batch-all", { method: "POST" }); return r.payouts.length; }).then((n) => { if (n !== undefined) reloadAll(); })}>
              Create batches for everyone payable
            </button>
          </>
        }
      />
      <Alert kind="error">{error ?? payableError}</Alert>
      <div className="card">
        <h2>Waiting to be paid</h2>
        <p className="muted">Payable money can go into a batch today. Held money is still inside its program&rsquo;s holding period — release one early with Pay now on the Commissions page.</p>
        <Table
          rows={payable?.balances}
          keyOf={(b: any) => `${b.affiliateId}:${b.currency}`}
          empty="No unpaid commissions."
          columns={[
            { header: "Affiliate", cell: (b: any) => <Link href={`/app/affiliates/${b.affiliateId}`}>{name(b)}</Link> },
            { header: "Payable now", cell: (b: any) => money(b.payableMinor, b.currency), num: true },
            {
              header: "Held",
              num: true,
              cell: (b: any) =>
                b.heldMinor ? (
                  <>
                    {money(b.heldMinor, b.currency)}
                    <div className="muted small">
                      {b.heldCount} commission{b.heldCount === 1 ? "" : "s"}
                    </div>
                  </>
                ) : (
                  "—"
                ),
            },
            { header: "Next release", cell: (b: any) => (b.heldMinor ? date(b.nextPayableAt) : "—") },
            {
              header: "",
              cell: (b: any) =>
                b.payableMinor > 0 ? (
                  <button className="sm primary" disabled={busy} onClick={() => run(() => api("/v1/payouts", { method: "POST", json: { affiliateId: b.affiliateId } }), "Draft batch created.").then(reloadAll)}>
                    Create draft batch
                  </button>
                ) : null,
            },
          ]}
        />
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
              reloadAll();
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
      <div className="card">
        <Table
          rows={data?.payouts}
          keyOf={(p: any) => p.id}
          empty="No payouts yet."
          columns={[
            { header: "Created", cell: (p: any) => dateTime(p.createdAt) },
            { header: "Affiliate", cell: (p: any) => <Link href={`/app/affiliates/${p.affiliateId}`}>{name(p)}</Link> },
            { header: "Amount", cell: (p: any) => money(p.amountMinor, p.currency), num: true },
            { header: "Method", cell: (p: any) => <>{p.method ?? p.payoutMethod ?? "—"}{p.provider ? <div className="muted">{p.provider === "stripe_connect" ? "Stripe" : "PayPal"}{p.providerStatus ? ` · ${p.providerStatus}` : ""}</div> : null}</> },
            { header: "Reference", cell: (p: any) => <span className="mono">{p.externalReference ?? p.providerRef ?? p.failureReason ?? "—"}</span> },
            { header: "Status", cell: (p: any) => <Badge value={p.status} /> },
            {
              header: "",
              cell: (p: any) => (
                <span className="actions">
                  {p.canSend ? (
                    <button className="sm primary" disabled={busy} onClick={() => run(() => api(`/v1/payouts/${p.id}/send`, { method: "POST" }), `Sending via ${p.providerId === "paypal" ? "PayPal" : "Stripe"}…`).then(reloadAll)}>
                      Send via {p.providerId === "paypal" ? "PayPal" : "Stripe"}
                    </button>
                  ) : null}
                  {p.status === "draft" && (
                    <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/payouts/${p.id}/processing`, { method: "POST" }), "Payout started.").then(reloadAll)}>
                      Start
                    </button>
                  )}
                  {["draft", "processing"].includes(p.status) && (
                    <button
                      className="sm primary"
                      disabled={busy}
                      onClick={async () => {
                        const ref = await askReason({
                          title: `Mark ${money(p.amountMinor, p.currency)} to ${name(p)} as paid?`,
                          body: "Its commissions become paid and the affiliate is told. Do this once the money has actually left.",
                          label: "Payment reference (optional)",
                          placeholder: "Bank or transfer id",
                          help: "Shown to the affiliate, so they can match it to their statement.",
                          required: false,
                          multiline: false,
                          confirmLabel: "Mark paid",
                        });
                        if (ref !== null) run(() => api(`/v1/payouts/${p.id}/paid`, { method: "POST", json: { externalReference: ref || undefined } }), "Payout marked paid.").then(reloadAll);
                      }}
                    >
                      Mark paid
                    </button>
                  )}
                  {p.status === "processing" && (
                    <button
                      className="sm danger"
                      disabled={busy}
                      onClick={async () => {
                        const r = await askReason({
                          title: "Mark this payout as failed?",
                          body: "The batch stays together so you can retry it, or cancel it to release its commissions.",
                          label: "What went wrong",
                          placeholder: "Bank rejected the transfer, wrong account details…",
                          confirmLabel: "Mark failed",
                          danger: true,
                        });
                        if (r) run(() => api(`/v1/payouts/${p.id}/failed`, { method: "POST", json: { reason: r } }), "Payout marked failed.").then(reloadAll);
                      }}
                    >
                      Failed
                    </button>
                  )}
                  {p.status === "failed" && (
                    <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/payouts/${p.id}/processing`, { method: "POST" }), "Payout started again.").then(reloadAll)}>
                      Retry
                    </button>
                  )}
                  {["draft", "failed"].includes(p.status) && (
                    <button
                      className="sm"
                      disabled={busy}
                      onClick={async () => {
                        const r = await askReason({
                          title: `Cancel this ${money(p.amountMinor, p.currency)} batch?`,
                          body: "Nothing is paid. Its commissions go back to payable, ready for a new batch.",
                          label: "Reason",
                          confirmLabel: "Cancel batch",
                          cancelLabel: "Keep it",
                          danger: true,
                        });
                        if (r) run(() => api(`/v1/payouts/${p.id}/cancel`, { method: "POST", json: { reason: r } }), "Batch cancelled.").then(reloadAll);
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
