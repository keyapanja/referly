"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

export default function ProgramsPage() {
  const { data, error, reload } = useApi<any>("/v1/programs");
  const { data: offers } = useApi<any>("/v1/offers");
  const { busy, error: actionError, run } = useAction();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: "", commissionModel: "percentage", commissionPercent: "20", commissionFixed: "", holdingDays: "30", attributionWindowDays: "30", approvalMode: "manual", refundPolicy: "full", precedence: "coupon_wins", termsText: "", offerIds: [] as string[] });

  return (
    <>
      <PageHeader title="Programs" subtitle="Commission, attribution and approval rules." actions={<button className="primary" onClick={() => setShow(!show)}>New program</button>} />
      <Alert kind="error">{error ?? actionError}</Alert>
      {show && (
        <div className="card">
          <h2>New program</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() =>
                api("/v1/programs", {
                  method: "POST",
                  json: {
                    name: form.name,
                    commissionModel: form.commissionModel,
                    commissionPercent: form.commissionModel === "percentage" ? Number(form.commissionPercent) : undefined,
                    commissionFixedMinor: form.commissionModel === "fixed" ? Math.round(Number(form.commissionFixed) * 100) : undefined,
                    holdingDays: Number(form.holdingDays),
                    attributionWindowDays: Number(form.attributionWindowDays),
                    approvalMode: form.approvalMode,
                    refundPolicy: form.refundPolicy,
                    precedence: form.precedence,
                    termsText: form.termsText,
                    offerIds: form.offerIds,
                  },
                }),
              );
              if (ok) {
                setShow(false);
                reload();
              }
            }}
          >
            <Field label="Name">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <div className="row">
              <Field label="Commission model">
                <select value={form.commissionModel} onChange={(e) => setForm({ ...form, commissionModel: e.target.value })}>
                  <option value="percentage">Percentage of sale</option>
                  <option value="fixed">Fixed amount per sale</option>
                </select>
              </Field>
              {form.commissionModel === "percentage" ? (
                <Field label="Commission %">
                  <input inputMode="decimal" value={form.commissionPercent} onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })} required />
                </Field>
              ) : (
                <Field label="Fixed amount">
                  <input inputMode="decimal" value={form.commissionFixed} onChange={(e) => setForm({ ...form, commissionFixed: e.target.value })} required />
                </Field>
              )}
              <Field label="Holding period (days)">
                <input inputMode="numeric" value={form.holdingDays} onChange={(e) => setForm({ ...form, holdingDays: e.target.value })} required />
              </Field>
              <Field label="Attribution window (days)">
                <input inputMode="numeric" value={form.attributionWindowDays} onChange={(e) => setForm({ ...form, attributionWindowDays: e.target.value })} required />
              </Field>
              <Field label="Approval">
                <select value={form.approvalMode} onChange={(e) => setForm({ ...form, approvalMode: e.target.value })}>
                  <option value="manual">Manual review</option>
                  <option value="auto">Automatic</option>
                  <option value="invite_only">Invite only</option>
                </select>
              </Field>
              <Field label="Refund policy">
                <select value={form.refundPolicy} onChange={(e) => setForm({ ...form, refundPolicy: e.target.value })}>
                  <option value="full">Reverse fully</option>
                  <option value="partial">Reduce proportionally</option>
                  <option value="none">Keep commission</option>
                </select>
              </Field>
              <Field label="When link and coupon both apply">
                <select value={form.precedence} onChange={(e) => setForm({ ...form, precedence: e.target.value })}>
                  <option value="coupon_wins">Coupon code wins</option>
                  <option value="link_wins">Link click wins</option>
                </select>
              </Field>
            </div>
            <Field label="Offers in this program">
              {offers?.offers?.length ? (
                <div className="list-inline">
                  {offers.offers.map((o: any) => (
                    <label key={o.id} className="checkbox">
                      <input type="checkbox" checked={form.offerIds.includes(o.id)} onChange={(e) => setForm({ ...form, offerIds: e.target.checked ? [...form.offerIds, o.id] : form.offerIds.filter((x) => x !== o.id) })} />
                      {o.name}
                    </label>
                  ))}
                </div>
              ) : (
                <div className="help">Create an offer first.</div>
              )}
            </Field>
            <Field label="Terms affiliates must accept">
              <textarea value={form.termsText} onChange={(e) => setForm({ ...form, termsText: e.target.value })} />
            </Field>
            <button className="primary" disabled={busy}>
              Create draft
            </button>
          </form>
        </div>
      )}
      <div className="card">
        <Table
          rows={data?.programs}
          keyOf={(p: any) => p.id}
          empty="No programs yet."
          columns={[
            { header: "Program", cell: (p: any) => <Link href={`/app/programs/${p.id}`}><strong>{p.name}</strong></Link> },
            { header: "Commission", cell: (p: any) => (p.commissionModel === "percentage" ? `${p.commissionRateBps / 100}%` : `fixed ${(p.commissionFixedMinor / 100).toFixed(2)}`) },
            { header: "Window", cell: (p: any) => `${p.attributionWindowDays}d` },
            { header: "Holding", cell: (p: any) => `${p.holdingDays}d` },
            { header: "Approval", cell: (p: any) => p.approvalMode.replace("_", " ") },
            { header: "Status", cell: (p: any) => <Badge value={p.status} /> },
          ]}
        />
      </div>
    </>
  );
}
