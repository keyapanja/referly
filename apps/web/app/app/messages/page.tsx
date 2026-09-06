"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Alert, Badge, Field, PageHeader, Table } from "@/components/ui";

export default function MessagesPage() {
  const { data, error, reload } = useApi<any>("/v1/messages/templates");
  const { data: log } = useApi<any>("/v1/messages/log?limit=50");
  const { busy, error: actionError, success, run } = useAction();
  const [editing, setEditing] = useState<any>(null);

  return (
    <>
      <PageHeader title="Messages" subtitle="Templates use safe variables only. Nothing is generated automatically." />
      <Alert kind="error">{error ?? actionError}</Alert>
      <Alert kind="success">{success}</Alert>
      <div className="grid cols-2">
        <div className="card">
          <h2>Templates</h2>
          <p className="muted">Variables: {data?.variables?.map((v: string) => `{{${v}}}`).join(" ")}</p>
          <Table
            rows={data?.templates}
            keyOf={(t: any) => t.id}
            columns={[
              { header: "Event", cell: (t: any) => t.key.replace(/_/g, " ") },
              { header: "Subject", cell: (t: any) => t.subject },
              { header: "", cell: (t: any) => <><Badge value={t.enabled ? "active" : "disabled"} /> <button className="sm" onClick={() => setEditing({ ...t })}>Edit</button></> },
            ]}
          />
        </div>
        <div className="card">
          {editing ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await run(() => api(`/v1/messages/templates/${editing.key}`, { method: "PATCH", json: { subject: editing.subject, body: editing.body, enabled: editing.enabled } }), "Template saved.");
                if (ok) {
                  setEditing(null);
                  reload();
                }
              }}
            >
              <h2>Edit: {editing.key.replace(/_/g, " ")}</h2>
              <Field label="Subject">
                <input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
              </Field>
              <Field label="Body">
                <textarea style={{ minHeight: 200 }} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
              </Field>
              <label className="checkbox" style={{ marginBottom: 12 }}>
                <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> Enabled
              </label>
              <div className="actions">
                <button className="primary" disabled={busy}>
                  Save
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="empty">Select a template to edit.</div>
          )}
        </div>
      </div>
      <div className="card">
        <h2>Delivery log</h2>
        <Table
          rows={log?.messages}
          keyOf={(m: any) => m.id}
          empty="No messages sent yet."
          columns={[
            { header: "When", cell: (m: any) => dateTime(m.createdAt) },
            { header: "Event", cell: (m: any) => m.templateKey.replace(/_/g, " ") },
            { header: "To", cell: (m: any) => m.recipient },
            { header: "Subject", cell: (m: any) => m.subject ?? "—" },
            { header: "Status", cell: (m: any) => <><Badge value={m.status} /> {m.error ? <span className="muted">{m.error}</span> : null}</> },
          ]}
        />
      </div>
    </>
  );
}
