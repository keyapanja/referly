"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money, toMinor } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

function ConversionsList() {
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const { data, error, reload } = useApi<any>(`/v1/conversions${status ? `?status=${status}` : ""}`);
  const { data: offers } = useApi<any>("/v1/offers");
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { data: programs } = useApi<any>("/v1/programs");
  const { busy, error: actionError, run } = useAction();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ externalOrderId: "", offerId: "", amount: "", affiliateId: "", programId: "", couponCode: "", reason: "" });

  return (
    <>
      <PageHeader
        title="Conversions"
        subtitle="Orders received from your checkout, API or entered manually."
        actions={
          <>
            <select value={status} onChange={(e) => (window.location.search = e.target.value ? `?status=${e.target.value}` : "")}>
              <option value="">All statuses</option>
              {["pending", "approved", "refunded", "cancelled", "reversed", "disputed"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <button className="primary" onClick={() => setShow(!show)}>
              Record manually
            </button>
          </>
        }
      />
      <Alert kind="error">{error ?? actionError}</Alert>
      {show && (
        <div className="card">
          <h2>Record a conversion</h2>
          <p className="muted">Attribute by coupon code, or pick an affiliate directly with a reason (audited).</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() =>
                api("/v1/conversions", {
                  method: "POST",
                  json: {
                    source: "manual",
                    externalOrderId: form.externalOrderId,
                    offerId: form.offerId || undefined,
                    amountMinor: toMinor(form.amount),
                    couponCode: form.couponCode || undefined,
                    affiliateId: form.affiliateId || undefined,
                    programId: form.affiliateId ? form.programId || undefined : undefined,
                    reason: form.reason || undefined,
                  },
                }),
              );
              if (ok) {
                setShow(false);
                reload();
              }
            }}
          >
            <div className="row">
              <Field label="Order reference">
                <input value={form.externalOrderId} onChange={(e) => setForm({ ...form, externalOrderId: e.target.value })} required />
              </Field>
              <Field label="Amount">
                <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
              </Field>
              <Field label="Offer">
                <select value={form.offerId} onChange={(e) => setForm({ ...form, offerId: e.target.value })}>
                  <option value="">Unknown</option>
                  {offers?.offers?.map((o: any) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Coupon code used">
                <input value={form.couponCode} onChange={(e) => setForm({ ...form, couponCode: e.target.value })} />
              </Field>
              <Field label="Or attribute to affiliate">
                <select value={form.affiliateId} onChange={(e) => setForm({ ...form, affiliateId: e.target.value })}>
                  <option value="">Use coupon / none</option>
                  {affiliates?.affiliates?.map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Program (for manual attribution)">
                <select value={form.programId} onChange={(e) => setForm({ ...form, programId: e.target.value })}>
                  <option value="">Choose…</option>
                  {programs?.programs?.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Reason (required for manual attribution)">
              <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </Field>
            <button className="primary" disabled={busy}>
              Record
            </button>
          </form>
        </div>
      )}
      <div className="card">
        <Table
          rows={data?.conversions}
          keyOf={(c: any) => c.id}
          empty="No conversions yet. Connect your checkout with an API key from Settings."
          columns={[
            { header: "When", cell: (c: any) => <Link href={`/app/conversions/${c.id}`}>{dateTime(c.occurredAt)}</Link> },
            { header: "Order", cell: (c: any) => <span className="mono">{c.externalOrderId}</span> },
            { header: "Amount", cell: (c: any) => money(c.amountMinor - c.refundedAmountMinor, c.currency), num: true },
            { header: "Affiliate", cell: (c: any) => (c.affiliateId ? <Link href={`/app/affiliates/${c.affiliateId}`}>{affiliates?.affiliates?.find((a: any) => a.id === c.affiliateId)?.name ?? "view"}</Link> : <span className="muted">unattributed</span>) },
            { header: "Source", cell: (c: any) => `${c.source} / ${c.attributionSource}` },
            { header: "Status", cell: (c: any) => <Badge value={c.status} /> },
          ]}
        />
      </div>
    </>
  );
}

export default function ConversionsPage() {
  return (
    <Suspense>
      <ConversionsList />
    </Suspense>
  );
}
