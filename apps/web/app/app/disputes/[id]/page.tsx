"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { Alert, Badge, Field, Loading, PageHeader } from "@/components/ui";

const KIND: Record<string, string> = { attribution: "Attribution", amount: "Amount", fraud: "Fraud / invalid sale", refund: "Refund", other: "Other" };

export default function DisputeDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<any>(`/v1/disputes/${id}`);
  const { data: affiliates } = useApi<any>("/v1/affiliates?status=active");
  const { data: programs } = useApi<any>("/v1/programs");
  const { busy, error: actionError, success, run } = useAction();
  const [comment, setComment] = useState("");
  const [link, setLink] = useState("");
  const [res, setRes] = useState({ resolution: "upheld", outcome: "restore", note: "", affiliateId: "", programId: "" });
  if (!data) return <Loading error={error} />;
  const d = data.dispute;
  const conv = data.conversion;
  const open = d.status === "open" || d.status === "under_review";

  return (
    <>
      <PageHeader
        title={`${KIND[d.kind] ?? d.kind} dispute`}
        subtitle={
          <>
            <Badge value={d.status} /> · raised by {d.raisedBy === "affiliate" ? "affiliate" : "merchant"} · {dateTime(d.createdAt)}
            {d.resolution ? <> · resolution: <strong>{d.resolution}</strong></> : null}
          </>
        }
        actions={d.status === "open" ? <button disabled={busy} onClick={() => run(() => api(`/v1/disputes/${id}/review`, { method: "POST" }), "Marked under review.").then(reload)}>Start review</button> : null}
      />
      <Alert kind="error">{actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Claim</h2>
          <p>{d.reason}</p>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Affiliate</dt>
            <dd>{d.affiliateId ? <Link href={`/app/affiliates/${d.affiliateId}`}>{data.affiliate?.name ?? d.affiliateId}</Link> : "—"}</dd>
            <dt>Sale</dt>
            <dd>
              {conv ? (
                <>
                  <Link href={`/app/conversions/${conv.id}`}>{conv.externalOrderId}</Link> · {money(conv.amountMinor, conv.currency)} · <Badge value={conv.status} />
                  {data.commission ? <div className="muted">Commission {money(data.commission.amountMinor, data.commission.currency)} · {data.commission.status}</div> : null}
                </>
              ) : (
                <>
                  <span className="muted">Not linked{d.orderReference ? ` · affiliate referenced order "${d.orderReference}"` : ""}</span>
                  {open ? (
                    <form
                      style={{ marginTop: 8 }}
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const ok = await run(() => api(`/v1/disputes/${id}/link`, { method: "POST", json: { conversionId: link } }), "Sale linked.");
                        if (ok) reload();
                      }}
                    >
                      <div className="actions">
                        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="conversion id (cnv_…)" style={{ width: 260 }} required />
                        <button className="sm" disabled={busy}>
                          Link sale
                        </button>
                      </div>
                    </form>
                  ) : null}
                </>
              )}
            </dd>
            {d.resolutionNote ? (
              <>
                <dt>Resolution note</dt>
                <dd>{d.resolutionNote}</dd>
              </>
            ) : null}
          </dl>
        </div>
        <div className="card">
          <h2>Resolve</h2>
          {open ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await run(
                  () =>
                    api(`/v1/disputes/${id}/resolve`, {
                      method: "POST",
                      json: { resolution: res.resolution, outcome: res.outcome, note: res.note, reattributeTo: res.outcome === "reattribute" ? { affiliateId: res.affiliateId, programId: res.programId } : undefined },
                    }),
                  "Dispute resolved.",
                );
                if (ok) reload();
              }}
            >
              <div className="row">
                <Field label="Decision">
                  <select value={res.resolution} onChange={(e) => setRes({ ...res, resolution: e.target.value })}>
                    <option value="upheld">Upheld (the claim is right)</option>
                    <option value="rejected">Rejected (the claim is wrong)</option>
                  </select>
                </Field>
                <Field label="What happens to the sale" help="Restore puts the sale back as it was. Cancel reverses its commission. Reattribute moves it to another affiliate.">
                  <select value={res.outcome} onChange={(e) => setRes({ ...res, outcome: e.target.value })}>
                    <option value="restore">Restore as it was</option>
                    <option value="cancel">Cancel the sale and reverse commission</option>
                    <option value="reattribute">Reattribute to another affiliate</option>
                  </select>
                </Field>
              </div>
              {res.outcome === "reattribute" ? (
                <div className="row">
                  <Field label="Affiliate">
                    <select value={res.affiliateId} onChange={(e) => setRes({ ...res, affiliateId: e.target.value })} required>
                      <option value="">Choose…</option>
                      {affiliates?.affiliates?.map((a: any) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Program">
                    <select value={res.programId} onChange={(e) => setRes({ ...res, programId: e.target.value })} required>
                      <option value="">Choose…</option>
                      {programs?.programs?.map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : null}
              <Field label="Note to the affiliate (recorded and sent)">
                <textarea value={res.note} onChange={(e) => setRes({ ...res, note: e.target.value })} required style={{ minHeight: 70 }} />
              </Field>
              <button className="primary" disabled={busy || (!conv && res.outcome !== "restore")}>
                Resolve dispute
              </button>
              {!conv && res.outcome !== "restore" ? <div className="help">Link the sale first to cancel or reattribute it.</div> : null}
            </form>
          ) : (
            <p className="muted">
              Resolved {d.resolvedAt ? dateTime(d.resolvedAt) : ""} as <strong>{d.resolution}</strong>
              {d.outcome ? ` · ${d.outcome}` : ""}.
            </p>
          )}
        </div>
      </div>
      <div className="card">
        <h2>Conversation</h2>
        {data.comments.length === 0 ? <p className="muted">No comments yet.</p> : null}
        {data.comments.map((c: any) => (
          <div key={c.id} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
            <div className="muted" style={{ fontSize: 12 }}>
              <strong style={{ color: "var(--text)" }}>{c.authorType === "affiliate" ? (data.affiliate?.name ?? "Affiliate") : c.authorType === "system" ? "System" : "Merchant"}</strong> · {dateTime(c.createdAt)}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>
          </div>
        ))}
        {open ? (
          <form
            style={{ marginTop: 12 }}
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api(`/v1/disputes/${id}/comments`, { method: "POST", json: { body: comment } }));
              if (ok) {
                setComment("");
                reload();
              }
            }}
          >
            <Field label="Reply (the affiliate is notified)">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} required style={{ minHeight: 60 }} />
            </Field>
            <button className="sm" disabled={busy}>
              Post reply
            </button>
          </form>
        ) : null}
      </div>
    </>
  );
}
