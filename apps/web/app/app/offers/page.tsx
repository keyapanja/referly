"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { money, toMinor } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

const TYPES = ["coaching", "course", "workshop", "event", "membership", "consulting", "custom"];
const NEXT: Record<string, string[]> = { draft: ["active", "archived"], active: ["paused", "archived"], paused: ["active", "archived"], archived: [] };

export default function OffersPage() {
  const { data: me } = useApi<any>("/v1/tenant/me");
  const { data, error, reload } = useApi<any>("/v1/offers");
  const { busy, error: actionError, run } = useAction();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: "", type: "coaching", price: "", salesUrl: "", shortDescription: "" });
  const cur = me?.tenant?.currency ?? "USD";

  return (
    <>
      <PageHeader title="Offers" subtitle="Products and services affiliates can promote." actions={<button className="primary" onClick={() => setShow(!show)}>New offer</button>} />
      <Alert kind="error">{error ?? actionError}</Alert>
      {show && (
        <div className="card">
          <h2>New offer</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api("/v1/offers", { method: "POST", json: { name: form.name, type: form.type, priceMinor: toMinor(form.price), salesUrl: form.salesUrl, shortDescription: form.shortDescription || undefined } }));
              if (ok) {
                setShow(false);
                setForm({ name: "", type: "coaching", price: "", salesUrl: "", shortDescription: "" });
                reload();
              }
            }}
          >
            <div className="row">
              <Field label="Name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field label="Type">
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Field label={`Price (${cur})`}>
                <input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
              </Field>
              <Field label="Sales page URL">
                <input type="url" value={form.salesUrl} onChange={(e) => setForm({ ...form, salesUrl: e.target.value })} required />
              </Field>
            </div>
            <Field label="Short description (shown to affiliates)">
              <textarea value={form.shortDescription} onChange={(e) => setForm({ ...form, shortDescription: e.target.value })} />
            </Field>
            <button className="primary" disabled={busy}>
              Create draft
            </button>
          </form>
        </div>
      )}
      <div className="card">
        <Table
          rows={data?.offers}
          keyOf={(o: any) => o.id}
          empty="No offers yet. Create one to get started."
          columns={[
            { header: "Offer", cell: (o: any) => <strong>{o.name}</strong> },
            { header: "Type", cell: (o: any) => o.type },
            { header: "Price", cell: (o: any) => money(o.priceMinor, o.currency), num: true },
            { header: "Sales URL", cell: (o: any) => <a href={o.salesUrl} target="_blank" rel="noreferrer" className="mono">{o.salesUrl}</a> },
            { header: "Status", cell: (o: any) => <Badge value={o.status} /> },
            {
              header: "",
              cell: (o: any) => (
                <span className="actions">
                  {NEXT[o.status]?.map((s) => (
                    <button key={s} className="sm" disabled={busy} onClick={() => run(() => api(`/v1/offers/${o.id}/status`, { method: "POST", json: { status: s } })).then(reload)}>
                      {s === "active" ? "Activate" : s === "paused" ? "Pause" : "Archive"}
                    </button>
                  ))}
                </span>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}
