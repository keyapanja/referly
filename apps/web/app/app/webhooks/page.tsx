"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, CopyBox, Field, PageHeader, Table } from "@/components/ui";

export default function WebhooksPage() {
  const { data, error, reload } = useApi<any>("/v1/webhooks");
  const { data: catalog } = useApi<any>("/v1/webhooks/events");
  const { busy, error: actionError, success, run } = useAction();
  const [form, setForm] = useState({ url: "", description: "", all: true, events: [] as string[] });
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { data: deliveries, reload: reloadDeliveries } = useApi<any>(open ? `/v1/webhooks/${open}/deliveries` : null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  return (
    <>
      <PageHeader title="Webhooks" subtitle="Send events to Zapier, Make or your own systems. Every delivery is signed, retried with backoff, and logged." />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      {secret ? (
        <Alert kind="info">
          <strong>Signing secret for the new endpoint.</strong> Copy it now; it will not be shown again. Use it to verify the <code>x-referly-signature</code> header.
          <div className="copy" style={{ marginTop: 8 }}>
            <CopyBox value={secret.value} />
          </div>
        </Alert>
      ) : null}
      <div className="grid cols-2">
        <div className="card">
          <h2>New endpoint</h2>
          <p className="muted">For Zapier, create a “Webhooks by Zapier · Catch Hook” trigger and paste its URL. For Make, use a “Custom webhook” module.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const res = await run(() => api<any>("/v1/webhooks", { method: "POST", json: { url: form.url, description: form.description || undefined, events: form.all ? ["*"] : form.events } }), "Endpoint added.");
              if (res) {
                setSecret({ id: res.subscription.id, value: res.secret });
                setForm({ url: "", description: "", all: true, events: [] });
                reload();
              }
            }}
          >
            <Field label="Endpoint URL">
              <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://hooks.zapier.com/hooks/catch/…" required />
            </Field>
            <Field label="Description (optional)">
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Zapier → Google Sheets" />
            </Field>
            <label className="checkbox" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={form.all} onChange={(e) => setForm({ ...form, all: e.target.checked })} /> Send every event
            </label>
            {!form.all ? (
              <Field label="Events">
                {catalog?.events?.map((ev: any) => (
                  <label key={ev.type} className="checkbox" style={{ marginBottom: 4 }}>
                    <input type="checkbox" checked={form.events.includes(ev.type)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev.type] : form.events.filter((x) => x !== ev.type) })} />
                    <span>
                      <code>{ev.type}</code> <span className="muted">{ev.description}</span>
                    </span>
                  </label>
                ))}
              </Field>
            ) : null}
            <button className="primary" disabled={busy || (!form.all && form.events.length === 0)}>
              Add endpoint
            </button>
          </form>
        </div>
        <div className="card">
          <h2>How to verify a delivery</h2>
          <p className="muted">Each request carries these headers:</p>
          <ul>
            <li>
              <code>x-referly-event</code> · the event type
            </li>
            <li>
              <code>x-referly-delivery</code> · a unique delivery id (deduplicate on it)
            </li>
            <li>
              <code>x-referly-timestamp</code> · unix seconds
            </li>
            <li>
              <code>x-referly-signature</code> · <code>v1=hex(HMAC_SHA256(secret, timestamp + "." + rawBody))</code>
            </li>
          </ul>
          <p className="muted">Respond with any 2xx within 10 seconds. Failures are retried 8 times with exponential backoff; after 5 exhausted deliveries in a row the endpoint is paused and a task is created.</p>
        </div>
      </div>
      <div className="card">
        <h2>Endpoints</h2>
        <Table
          rows={data?.subscriptions}
          keyOf={(s: any) => s.id}
          empty="No endpoints yet."
          columns={[
            { header: "Endpoint", cell: (s: any) => <><span className="mono" style={{ wordBreak: "break-all" }}>{s.url}</span>{s.description ? <div className="muted">{s.description}</div> : null}</> },
            { header: "Events", cell: (s: any) => (s.events.includes("*") ? "all" : `${s.events.length} selected`) },
            { header: "Status", cell: (s: any) => <><Badge value={s.status} />{s.lastStatus ? <div className="muted">last: {s.lastStatus} · {dateTime(s.lastDeliveryAt)}</div> : null}</> },
            { header: "Deliveries", cell: (s: any) => `${s.stats.delivered} ok · ${s.stats.dead} dead`, num: true },
            {
              header: "",
              cell: (s: any) => (
                <span className="actions">
                  <button className="sm" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Hide log" : "Log"}</button>
                  <button className="sm" disabled={busy} onClick={() => run(async () => { const r = await api<any>(`/v1/webhooks/${s.id}/test`, { method: "POST" }); setTestResult({ ...testResult, [s.id]: r.ok ? `ok (${r.status})` : `failed: ${r.error ?? r.status}` }); return r; }).then(() => { reload(); if (open === s.id) reloadDeliveries(); })}>
                    Send test
                  </button>
                  {s.status === "active" ? (
                    <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/webhooks/${s.id}`, { method: "PATCH", json: { status: "paused" } })).then(reload)}>Pause</button>
                  ) : (
                    <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/webhooks/${s.id}`, { method: "PATCH", json: { status: "active" } })).then(reload)}>Resume</button>
                  )}
                  <button className="sm danger" disabled={busy} onClick={() => run(() => api(`/v1/webhooks/${s.id}`, { method: "DELETE" }), "Endpoint removed.").then(() => { if (open === s.id) setOpen(null); reload(); })}>Delete</button>
                  {testResult[s.id] ? <span className="muted">{testResult[s.id]}</span> : null}
                </span>
              ),
            },
          ]}
        />
      </div>
      {open ? (
        <div className="card">
          <h2>Delivery log</h2>
          <Table
            rows={deliveries?.deliveries}
            keyOf={(d: any) => d.id}
            empty="Nothing delivered yet."
            columns={[
              { header: "When", cell: (d: any) => dateTime(d.createdAt) },
              { header: "Event", cell: (d: any) => <code>{d.eventType}</code> },
              { header: "Status", cell: (d: any) => <><Badge value={d.status} />{d.error ? <div className="muted">{d.error}</div> : null}</> },
              { header: "Attempts", cell: (d: any) => d.attempts, num: true },
              { header: "Response", cell: (d: any) => (d.responseStatus != null ? <><strong>{d.responseStatus}</strong> <span className="muted mono">{(d.responseBody ?? "").slice(0, 80)}</span></> : "—") },
              { header: "", cell: (d: any) => (d.status === "dead" || d.status === "failed" ? <button className="sm" disabled={busy} onClick={() => run(() => api(`/v1/webhooks/deliveries/${d.id}/redeliver`, { method: "POST" }), "Queued for redelivery.").then(reloadDeliveries)}>Redeliver</button> : null) },
            ]}
          />
        </div>
      ) : null}
    </>
  );
}
