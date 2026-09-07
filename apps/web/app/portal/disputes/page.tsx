"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

const KIND: Record<string, string> = { attribution: "Missing attribution", amount: "Amount or commission", other: "Other" };

export default function PortalDisputes() {
  const { data, error, reload } = useApi<any>("/portal/disputes");
  const { data: conv } = useApi<any>("/portal/conversions");
  const { busy, error: actionError, success, run } = useAction();
  const [form, setForm] = useState({ kind: "attribution", conversionId: "", orderReference: "", reason: "" });
  const [open, setOpen] = useState<string | null>(null);
  const { data: detail, reload: reloadDetail } = useApi<any>(open ? `/portal/disputes/${open}` : null);
  const [comment, setComment] = useState("");

  return (
    <>
      <PageHeader title="Disputes" subtitle="Think a sale is missing or a commission is wrong? Raise it here and the merchant will review it." />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Raise a dispute</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(
                () =>
                  api("/portal/disputes", {
                    method: "POST",
                    json: { kind: form.kind, conversionId: form.kind === "attribution" ? undefined : form.conversionId || undefined, orderReference: form.kind === "attribution" ? form.orderReference : undefined, reason: form.reason },
                  }),
                "Dispute raised. You'll be notified of updates.",
              );
              if (ok) {
                setForm({ kind: "attribution", conversionId: "", orderReference: "", reason: "" });
                reload();
              }
            }}
          >
            <Field label="What is it about?">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {Object.entries(KIND).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            {form.kind === "attribution" ? (
              <Field label="Order reference" help="The order id, customer name or receipt number the merchant can look up.">
                <input value={form.orderReference} onChange={(e) => setForm({ ...form, orderReference: e.target.value })} required />
              </Field>
            ) : (
              <Field label="Which sale?">
                <select value={form.conversionId} onChange={(e) => setForm({ ...form, conversionId: e.target.value })} required>
                  <option value="">Choose…</option>
                  {conv?.conversions?.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {dateTime(c.occurredAt)} · {money(c.amountMinor, c.currency)} · {c.status}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Tell the merchant what happened">
              <textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required style={{ minHeight: 80 }} />
            </Field>
            <button className="primary" disabled={busy}>
              Submit
            </button>
          </form>
        </div>
        <div className="card">
          <h2>Your disputes</h2>
          <Table
            rows={data?.disputes}
            keyOf={(d: any) => d.id}
            empty="No disputes."
            columns={[
              { header: "Opened", cell: (d: any) => dateTime(d.createdAt) },
              { header: "About", cell: (d: any) => <><strong>{KIND[d.kind] ?? d.kind}</strong><div className="muted">{d.orderReference ?? d.conversion?.externalOrderId ?? ""}</div></> },
              { header: "Status", cell: (d: any) => <><Badge value={d.status} />{d.resolution ? <div className="muted">{d.resolution}</div> : null}</> },
              { header: "", cell: (d: any) => <button className="sm" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? "Close" : "Open"}</button> },
            ]}
          />
        </div>
      </div>
      {open && detail ? (
        <div className="card">
          <h2>{KIND[detail.dispute.kind] ?? detail.dispute.kind}</h2>
          <p>{detail.dispute.reason}</p>
          {detail.dispute.resolutionNote ? (
            <Alert kind={detail.dispute.resolution === "upheld" ? "success" : "info"}>
              <strong>Resolution: {detail.dispute.resolution}.</strong> {detail.dispute.resolutionNote}
            </Alert>
          ) : null}
          <h3>Conversation</h3>
          {detail.comments.map((c: any) => (
            <div key={c.id} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
              <div className="muted" style={{ fontSize: 12 }}>
                <strong style={{ color: "var(--text)" }}>{c.authorType === "affiliate" ? "You" : c.authorType === "system" ? "System" : "Merchant"}</strong> · {dateTime(c.createdAt)}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>
            </div>
          ))}
          {detail.dispute.status === "open" || detail.dispute.status === "under_review" ? (
            <>
              <form
                style={{ marginTop: 12 }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await run(() => api(`/portal/disputes/${open}/comments`, { method: "POST", json: { body: comment } }));
                  if (ok) {
                    setComment("");
                    reloadDetail();
                  }
                }}
              >
                <Field label="Add a comment">
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} required style={{ minHeight: 60 }} />
                </Field>
                <div className="actions">
                  <button className="sm" disabled={busy}>
                    Post
                  </button>
                  <button type="button" className="sm danger" disabled={busy} onClick={() => run(() => api(`/portal/disputes/${open}/withdraw`, { method: "POST" }), "Dispute withdrawn.").then(() => { reload(); reloadDetail(); })}>
                    Withdraw dispute
                  </button>
                </div>
              </form>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
