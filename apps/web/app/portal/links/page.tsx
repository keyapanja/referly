"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Alert, Badge, CopyBox, Field, PageHeader, Table } from "@/components/ui";

export default function PortalLinks() {
  const { data, error, reload } = useApi<any>("/portal/links");
  const { data: codes } = useApi<any>("/portal/codes");
  const { data: offers } = useApi<any>("/portal/offers");
  const { busy, error: actionError, run } = useAction();
  const [form, setForm] = useState({ offer: "", label: "" });

  return (
    <>
      <PageHeader title="Links & Codes" subtitle="Each link is unique to you. Add a label to track different placements (newsletter, bio, video)." />
      <Alert kind="error">{error ?? actionError}</Alert>
      <div className="card">
        <h2>Create a labelled link</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const [offerId, programId] = form.offer.split(":");
            const ok = await run(() => api("/portal/links", { method: "POST", json: { offerId, programId, label: form.label || undefined } }));
            if (ok) {
              setForm({ offer: "", label: "" });
              reload();
            }
          }}
        >
          <div className="row">
            <Field label="Offer">
              <select value={form.offer} onChange={(e) => setForm({ ...form, offer: e.target.value })} required>
                <option value="">Choose…</option>
                {offers?.offers?.map((o: any) => (
                  <option key={`${o.id}:${o.programId}`} value={`${o.id}:${o.programId}`}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Label (optional)">
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="newsletter" maxLength={60} />
            </Field>
          </div>
          <button className="primary" disabled={busy}>
            Create link
          </button>
        </form>
      </div>
      <div className="card">
        <h2>Your links</h2>
        <Table
          rows={data?.links}
          keyOf={(l: any) => l.id}
          empty="No links yet."
          columns={[
            { header: "Offer", cell: (l: any) => offers?.offers?.find((o: any) => o.id === l.offerId)?.name ?? l.offerId },
            { header: "Label", cell: (l: any) => l.label ?? <span className="muted">default</span> },
            { header: "Link", cell: (l: any) => <CopyBox value={l.url} /> },
            { header: "Clicks", cell: (l: any) => l.clickCount, num: true },
            { header: "", cell: (l: any) => <Badge value={l.status} /> },
          ]}
        />
      </div>
      <div className="card">
        <h2>Your coupon codes</h2>
        <p className="muted">Customers who use your code at checkout are attributed to you even without clicking your link.</p>
        <Table
          rows={codes?.codes}
          keyOf={(c: any) => c.id}
          empty="No codes assigned. Ask the merchant for one."
          columns={[
            { header: "Code", cell: (c: any) => <CopyBox value={c.code} /> },
            { header: "Discount", cell: (c: any) => (c.discountRule ? `${c.discountRule.value}${c.discountRule.type === "percentage" ? "%" : ""} off` : "—") },
            { header: "", cell: (c: any) => <Badge value={c.status} /> },
          ]}
        />
      </div>
    </>
  );
}
